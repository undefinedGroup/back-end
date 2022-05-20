FROM node:16

WORKDIR /app

COPY . /app/

COPY package*.json /app/

RUN npm ci \
    && npm run build

EXPOSE 3000
EXPOSE 80

CMD ["npm", "run", "start:prod"]