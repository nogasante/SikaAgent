FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY admin ./admin
ENV PORT=8080
CMD ["npm", "start"]
