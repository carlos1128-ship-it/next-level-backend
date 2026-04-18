const { join } = require('path');

/**
 * Mantem o cache do Puppeteer dentro do projeto para que o browser
 * baixado no build continue disponivel no runtime do Render.
 *
 * Referencia:
 * https://pptr.dev/guides/configuration
 */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
