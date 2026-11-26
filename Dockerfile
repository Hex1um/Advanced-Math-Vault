# 数海晴岸 · 零依赖后端
# 只用 Node 22 内置模块（含 node:sqlite），不需要 npm install。
FROM node:22-alpine

WORKDIR /app

# 先只拷代码与种子数据，利用镜像层缓存：
# 代码没变时重建不会重复拷贝 6000+ 道题。
COPY package.json ./
COPY server.js tag-taxonomy.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public
COPY tools ./tools
COPY data/batch-*.json data/problems.seed.json* ./data/

# 运行期数据目录（库、上传、备份）挂卷，容器本身保持无状态
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DB_ENGINE=sqlite

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>r.json()).then(j=>process.exit(j&&j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
