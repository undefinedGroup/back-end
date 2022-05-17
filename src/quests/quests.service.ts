import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import * as config from 'config';
import { Repository } from 'typeorm';
import { FeedRepository } from 'src/feeds/feeds.repository';
import { CreateFeedDto } from 'src/feeds/dto/create-feed.dto';
import { CommentRepository } from 'src/comments/comments.repository';
import { QuestsRepository } from 'src/quests/quests.repository';
import { Complete } from 'src/quests/entities/complete.entity';
import { Region } from 'src/quests/entities/region.entity';
import { Player } from 'src/players/entities/player.entity';

const mapConfig = config.get('map');

const KAKAO_BASE_URL = mapConfig.kakaoBaseUrl;
const REST_API_KEY = mapConfig.kakaoApiKey;
const JUSO_BASE_URL = mapConfig.jusoBaseUrl;
const JUSO_CONFIRM_KEY = mapConfig.josoConfirmKey;

@Injectable()
export class QuestsService {
  constructor(
    @InjectRepository(Complete)
    private readonly completes: Repository<Complete>,
    @InjectRepository(Region)
    private readonly regions: Repository<Region>,
    @InjectRepository(FeedRepository)
    private readonly feedRepository: FeedRepository,
    private readonly commentRepository: CommentRepository,
    private readonly questsRepository: QuestsRepository
  ) {}

  private readonly logger = new Logger(QuestsService.name);

  private today: Date;
  private todayDate: string;

  /* 24시에 날짜 업데이트 */
  @Cron('0 0 0 * * *', {
    name: 'setToday',
    timeZone: 'Asia/Seoul',
  })
  setToday() {
    this.today = new Date();
    this.todayDate = this.today.toDateString();
  }

  /* 피드작성 퀘스트 완료 요청 */
  feedQuest(questId: number, playerId: number, createFeedDto: CreateFeedDto) {
    const { img, content } = createFeedDto;
    return this.feedRepository.feedQuest(questId, playerId, img, content);
  }

  /* 타임어택 또는 몬스터 대결 퀘스트 완료 요청 */
  async questComplete(questId: number, playerId: number) {
    try {
      const quest = await this.questsRepository.findOneBy(questId);
      if (!quest)
        return { ok: false, message: '요청하신 퀘스트를 찾을 수 없습니다.' };

      const player = await Player.findOne({ where: { id: playerId } });
      if (!player)
        return { ok: false, message: '플레이어님의 정보를 찾을 수 없습니다.' };

      const isCompleted = await this.completes.findOne({ quest, player });
      if (isCompleted)
        return { ok: false, message: '퀘스트를 이미 완료하였습니다.' };

      await this.completes.save(this.completes.create({ quest, player }));
      return { ok: true };
    } catch (error) {
      return { ok: false, message: '퀘스트를 완료할 수 없습니다.' };
    }
  }

  /*
   * 퀘스트 조회 프로세스: player의 좌표 값으로 region 테이블 조회
   * DB에 데이터 있으면, 퀘스트 + 완료여부 조인해서 응답
   * DB에 데이터 없으면, 지역(동) + 퀘스트 데이터 DB에 생성하고 응답
   */

  /* 위도(lat), 경도(lng) 기준으로 우리 지역(동) 퀘스트 조회 */
  async getAll(lat: number, lng: number, playerId: number | null) {
    try {
      console.time('getAll');
      console.time('카카오API - getAddressName');
      const kakaoAddress = await this.getAddressName(lat, lng);
      console.timeEnd('카카오API - getAddressName');

      const date = this.today ? this.todayDate : new Date().toDateString();

      /* 오늘 우리 지역(동) 퀘스트가 있으면 조회, 없으면 생성해서 조회 */
      let region = await this.regions.findOne({ date, ...kakaoAddress });
      if (region) {
        const { regionSi, regionGu, regionDong } = region;
        const allQuests = await this.questsRepository.findAll(region, playerId);
        return {
          ok: true,
          currentRegion: { regionSi, regionGu, regionDong },
          rows: allQuests,
        };
      }

      // 지역(동), 좌표 값으로 퀘스트 만들기
      console.time('주소API - getRegionData');
      const { totalCount, pageCount } = await this.getRegionData(kakaoAddress);
      console.timeEnd('주소API - getRegionData');
      console.time('createQuests');
      const quests = await this.createQuests(
        totalCount,
        pageCount,
        kakaoAddress
      );
      console.timeEnd('createQuests');

      // 지역(동) 데이터 DB에 추가 및 조회
      region = this.regions.create({
        date,
        ...kakaoAddress,
        totalCount,
        pageCount,
      });
      await this.regions.save(region);

      // 퀘스트 데이터 DB에 추가 및 조회
      await Promise.all([
        ...quests.map(async (quest) => {
          return await this.questsRepository.createAndSave({
            ...quest,
            region,
          });
        }),
      ]);

      const { regionSi, regionGu, regionDong } = region;
      const allQuests = await this.questsRepository.findAll(region, playerId);
      console.timeEnd('getAll');
      return {
        ok: true,
        currentRegion: { regionSi, regionGu, regionDong },
        rows: allQuests,
      };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  /* 주소 데이터 얻어오기 */
  /**
   * @param {number} lat - 위도
   * @param {number} lng - 경도
   * @returns {object} - { 시, 구, 동 }
   */
  async getAddressName(lat, lng) {
    try {
      const res = await axios.get(
        `${KAKAO_BASE_URL}/geo/coord2address.json?x=${lng}&y=${lat}&input_coord=WGS84`,
        { headers: { Authorization: `KakaoAK ${REST_API_KEY}` } }
      );
      const { address } = res.data.documents[0];
      const regionSi: string = address.region_1depth_name;
      const regionGu: string = address.region_2depth_name;
      const regionDong: string = address.region_3depth_name;

      return { regionSi, regionGu, regionDong };
    } catch (error) {
      console.log(error.message);
    }
  }

  /* 특정 동의 개요 얻어오기 */
  /**
   * @param {object} kakaoAddress - { regionSi: string, regionGu: string, regionDong: string }
   * @returns {object} - { 전체 주소 개수, 페이지수 }
   */
  async getRegionData(kakaoAddress) {
    const address = `${kakaoAddress.regionSi} ${kakaoAddress.regionGu} ${kakaoAddress.regionDong}`;
    try {
      const res = await axios.get(
        `${JUSO_BASE_URL}?currentPage=1&countPerPage=10&keyword=${encodeURI(
          address
        )}&confmKey=${JUSO_CONFIRM_KEY}&resultType=json`
      );
      const { totalCount } = res.data.results.common;
      const pageCount = Math.ceil(totalCount / 100);
      return { totalCount, pageCount };
    } catch (error) {
      console.log(error.message);
    }
  }

  /* 퀘스트 만들기 */
  /**
   * @param {number} totalCount - 전체 주소 개수
   * @param {number} pageCount - 전체 페이지 수
   * @param {object} kakaoAddress - { regionSi: string, regionGu: string, regionDong: string }
   * @returns {array} - [ 퀘스트 ]
   */
  async createQuests(totalCount, pageCount, kakaoAddress) {
    const address = `${kakaoAddress.regionSi} ${kakaoAddress.regionGu} ${kakaoAddress.regionDong}`;
    const addrIndex = [];
    for (let curPage = 1; curPage < pageCount; curPage++) {
      const idx =
        curPage !== pageCount
          ? Math.floor(Math.random() * 100) + 1
          : Math.floor(Math.random() * (totalCount % 100)) + 1;
      addrIndex.push({ curPage: curPage, idx });
    }

    /* 각 페이지마다 랜덤 idx로 상세주소 얻기 */
    console.time('주소API - 한번에 불러오기');
    const rawRoadAddrs = await Promise.all([
      ...addrIndex.map(({ curPage, idx }) =>
        this.getRoadAddress(curPage, address, idx)
      ),
    ]);
    const roadAddrs = rawRoadAddrs.filter((addr) => addr);
    console.timeEnd('주소API - 한번에 불러오기');

    let questsCoords = [];
    const limits = 20; // kakaoAPI 429 에러(Too Many Requests) 방지를 위해 요청당 호출수 제한

    /* 상세주소에 해당하는 좌표값 얻기 */
    for (let begin = 0; begin < pageCount; begin += limits) {
      console.time('카카오API - getCoords');
      const end = begin + limits < pageCount ? begin + limits : pageCount;
      const roadAddrsSubset = roadAddrs.slice(begin, end);
      questsCoords = [
        ...questsCoords,
        ...(await Promise.all([
          ...roadAddrsSubset.map((roadAddr) => this.getCoords(roadAddr)),
        ])),
      ];
      console.timeEnd('카카오API - getCoords');
    }

    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const date = today.getDate();
    let type, title, description, reward, difficulty, timeUntil;
    let category;
    let hour;

    /* 좌표별로 퀘스트 만들기 */
    return questsCoords.map((coords) => {
      category = Math.floor(Math.random() * 9) + 1;
      switch (category) {
        case 1:
        case 2:
        case 3:
          type = 'time';
          title = '타임어택';
          if (category === 1) {
            hour = 9;
          } else {
            hour = category * 7;
          }
          description = `${hour}시까지 도착해서 땅땅 도장을 찍어주세요.`;
          difficulty = 1;
          reward = 5;
          timeUntil = new Date(year, month, date, hour);
          break;
        case 4:
        case 5:
        case 6:
          if (category === 4) {
            description =
              '특별한 기억이 있는 장소인가요? 여러분의 경험을 들려주세요. 낯선 곳이라면 첫번째 기억을 담으러 나서볼까요?';
          } else if (category === 5) {
            description =
              '동네 사람들에게 추천해 주고 싶은 장소인가요? 여러분의 리뷰를 남겨주세요.';
          } else {
            description =
              '오늘 하루는 어떠셨나요? 무심코 지나친 무채색의 장소를 여러분의 감정으로 채워주세요.';
          }
          type = 'feed';
          title = '땅땅 쓰기';
          difficulty = 2;
          reward = 8;
          timeUntil = null;
          break;
        case 7:
        case 8:
        case 9:
          type = 'mob';
          title = '몬스터 대결';
          description =
            '대결에서 승리하여 몬스터로부터 우리 동네를 지켜주세요.';
          difficulty = 3;
          reward = 10;
          timeUntil = null;
          break;
      }

      return {
        ...coords,
        type,
        title,
        description,
        reward,
        difficulty,
        timeUntil,
      };
    });
  }

  /* 상세주소 얻어오기 */
  /**
   * @param {number} curPage - 현재 페이지 번호
   * @param {string} address - "시 구 동"
   * @param {number} idx - 인덱스(1~100 랜덤)
   * @returns {string} - 상세주소 (ex. 서울특별시 강남구 언주로63길 20(역삼동))
   */
  async getRoadAddress(curPage, address, idx) {
    try {
      const res = await axios.get(
        `${JUSO_BASE_URL}?currentPage=${curPage}&countPerPage=100&keyword=${encodeURI(
          address
        )}&confmKey=${JUSO_CONFIRM_KEY}&resultType=json`
      );
      return res.data.results.juso[idx].roadAddr;
    } catch (error) {
      return;
    }
  }

  /* 좌표값 얻어오기 */
  /**
   * @param {string} roadAddr - 상세주소 (ex. 서울특별시 강남구 언주로63길 20(역삼동))
   * @returns {object} - { 위도, 경도 }
   */
  async getCoords(roadAddr) {
    try {
      const res = await axios.get(
        `${KAKAO_BASE_URL}/search/address.json?query=${encodeURI(roadAddr)}`,
        {
          headers: {
            Authorization: `KakaoAK ${REST_API_KEY}`,
          },
        }
      );
      const lat = res.data.documents[0].y;
      const lng = res.data.documents[0].x;
      return { lat, lng };
    } catch (error) {
      console.log(`getCoords: ${error.message}`);
    }
  }

  /* 특정 퀘스트 조회 */
  async getOne(id: number, playerId: number | null) {
    try {
      const quest = await this.questsRepository.findOneWithCompletes(
        id,
        playerId
      );
      if (!quest)
        return { ok: false, message: '해당 게시글을 찾을 수 없습니다.' };

      return { ok: true, row: quest };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  /* 어제의 지역(동) 데이터 기반으로 오늘의 새로운 퀘스트 만들기 */
  @Cron('0 0 2 * * *', {
    name: 'createQuests',
    timeZone: 'Asia/Seoul',
  })
  async preCreateQuests() {
    this.logger.verbose('퀘스트 사전 생성');

    const yesterday = new Date();
    yesterday.setDate(this.today.getDate() - 1);
    const yesterdayDate = yesterday.toDateString();
    let regions = await this.regions.find({ date: yesterdayDate });

    const todayDate = this.todayDate;
    for (const region of regions) {
      const { regionSi, regionGu, regionDong } = region;
      const isExisted = await this.regions.find({
        date: todayDate,
        regionSi,
        regionGu,
        regionDong,
      });
      if (isExisted.length !== 0) continue;
      const kakaoAddress = {
        regionSi: region.regionSi,
        regionGu: region.regionGu,
        regionDong: region.regionDong,
      };
      const { totalCount, pageCount } = region;
      const quests = await this.createQuests(
        totalCount,
        pageCount,
        kakaoAddress
      );
      let newRegion = this.regions.create({
        date: todayDate,
        ...kakaoAddress,
        totalCount,
        pageCount,
      });
      await this.regions.save(newRegion);

      await Promise.all([
        ...quests.map(async (quest) => {
          return await this.questsRepository.createAndSave({
            ...quest,
            region: newRegion,
          });
        }),
      ]);
    }
  }
}
