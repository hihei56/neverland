FROM node:20-slim

# canvas に必要なネイティブライブラリ
RUN apt-get update && apt-get install -y \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./

# アセットと whitelist は volume でマウント
RUN mkdir -p assets

CMD ["node", "index.js"]
