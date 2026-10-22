FROM oven/bun:1.4.3

WORKDIR /app

# Só as dependências de produção; o lockfile congelado garante as mesmas versões da CI
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --production

# O Bun executa o TypeScript direto, sem etapa de build
COPY src ./src
COPY scripts/migrate.ts ./scripts/migrate.ts

USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
