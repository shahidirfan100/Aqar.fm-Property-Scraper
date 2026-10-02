FROM apify/actor-node:22

COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false \
    && if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && node -e "import('impit').then(m => console.log('impit OK:', Object.keys(m)))" \
    && rm -rf ~/.npm

COPY --chown=myuser:myuser . ./

ENV APIFY_LOG_LEVEL=INFO

CMD npm start --silent
