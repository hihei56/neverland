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

COPY index.js dataPath.js ./

# アセットと data は volume でマウント
RUN mkdir -p assets data

CMD ["node", "index.js"]
