/**
 * 本机模拟 nginx 的「子路径反向代理」，用来验证：
 *   看板部署在 /board/ 子路径下时，猫猫素材的相对路径能否正确加载。
 *
 * 模拟的 nginx 配置（对应真实场景 www.yuanyihan.com.cn/board/）：
 *     location /board/ { proxy_pass http://127.0.0.1:8899/; }   —— 剥掉前缀
 *     location /api/   { proxy_pass http://127.0.0.1:8899; }    —— 原样转发
 *   第二条必需：前端所有接口都写成绝对路径 /api/...（既有代码如此），
 *   不带 /board 前缀，所以 nginx 必须单独把 /api/ 也交给看板。
 *
 * 其余请求一律返回「主站 404」，模拟被 nginx 交给主站的情形。
 */
const http = require('http');

const LISTEN = 8900;
const BOARD = { host: '127.0.0.1', port: 8899 };
const PREFIX = '/board';

http.createServer((req, res) => {
  // 只记录静态资源请求，便于观察猫猫到底请求了哪个 URL
  if (/\.(webp|webm|json)$/.test(req.url)) {
    console.log(`  [请求] ${req.url}`);
  }

  // 不带尾斜杠的 /board：真实 nginx 是否重定向取决于配置，这里如实返回 301
  if (req.url === PREFIX) {
    res.writeHead(301, { Location: PREFIX + '/' });
    res.end();
    console.log('  [301] /board -> /board/');
    return;
  }

  let path = null;
  let tag = '';
  if (req.url.startsWith(PREFIX + '/')) {
    path = req.url.slice(PREFIX.length);      // 剥掉 /board 前缀
    tag = 'board';
  } else if (req.url === '/api' || req.url.startsWith('/api/')) {
    path = req.url;                            // 接口原样转发
    tag = 'api';
  }

  if (path === null) {
    // 模拟「请求落到了主站」这一情形
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('MAIN SITE - not found: ' + req.url);
    console.log(`  [主站404] ${req.url}  ← 请求没落在 /board/ 下`);
    return;
  }

  const up = http.request(
    { host: BOARD.host, port: BOARD.port, path: path, method: req.method, headers: req.headers },
    (r) => {
      if (tag === 'api') console.log(`  [接口] ${req.method} ${req.url} -> ${r.statusCode}`);
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    }
  );
  up.on('error', () => { res.writeHead(502); res.end('board server down'); });
  req.pipe(up);
}).listen(LISTEN, '127.0.0.1', () => {
  console.log(`代理已启动: http://127.0.0.1:${LISTEN}${PREFIX}/  ->  http://127.0.0.1:${BOARD.port}/`);
  console.log(`           http://127.0.0.1:${LISTEN}/api/     ->  http://127.0.0.1:${BOARD.port}/api/`);
});
