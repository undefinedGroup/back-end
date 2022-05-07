import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from 'src/auth/auth.service';
import { Player } from './entities/player.entity';
import { PlayersController } from './players.controller';
import { PlayersService } from './players.service';
import * as config from 'config';
import { PlayerRepository } from './players.repository';

const jwtConfig = config.get('jwt');

@Module({
  imports: [
    TypeOrmModule.forFeature([Player, PlayerRepository]),
    JwtModule.register({
      secret: jwtConfig.secret,
      signOptions: { expiresIn: '60s' },
    }),
  ],
  providers: [PlayersService, AuthService],
  controllers: [PlayersController],
  exports: [PlayersService],
})
export class PlayersModule {}
