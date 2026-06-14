FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Bootstrap curl for NodeSource setup
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Add NodeSource (Node.js 22 LTS) repo, then install all runtimes in one layer
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends \
        unzip \
        build-essential gcc g++ mold \
        default-jdk \
        golang-go \
        python3 \
        ruby \
        php-cli \
        nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Kotlin compiler
RUN curl -fsSL https://github.com/JetBrains/kotlin/releases/download/v2.0.21/kotlin-compiler-2.0.21.zip \
      -o /tmp/kotlinc.zip \
    && unzip /tmp/kotlinc.zip -d /opt \
    && ln -s /opt/kotlinc/bin/kotlinc /usr/local/bin/kotlinc \
    && rm /tmp/kotlinc.zip

# App dependencies — cached layer, only rebuilds when package.json changes
COPY package*.json ./
RUN npm ci && npm cache clean --force

COPY . .

# Go build cache on tmpfs — faster repeated go run calls within a session
ENV GOCACHE=/tmp/go-cache

EXPOSE 6600
CMD ["node", "index.js"]
