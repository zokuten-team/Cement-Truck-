FROM node:20-bookworm

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/data"]

CMD ["npm", "start"]

