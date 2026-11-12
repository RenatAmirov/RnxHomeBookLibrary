import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLibrary } from './library.js';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const databasePath = process.env.LIBRARY_DB ?? fileURLToPath(new URL('./data/library.sqlite', import.meta.url));
const library = openLibrary(databasePath);
const port = Number(process.env.PORT ?? 3000);
const sessionDuration = 8 * 60 * 60 * 1000;
const sessions = new Map();
let attempts = [];

const mime = new Map([
  ['html', 'text/html; charset=utf-8'], ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'], ['jpg', 'image/jpeg'], ['woff2', 'font/woff2'],
  ['ico', 'image/x-icon']
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'Ожидаются данные в формате JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16_384) {
      request.resume();
      throw new HttpError(413, 'Слишком много данных.');
    }
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'Проверьте формат отправленных данных.');
  }
}

function field(value, label, max, required = true) {
  if (!required && value == null) return '';
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (required && !trimmed) throw new HttpError(400, `Заполните поле «${label}».`);
  if (trimmed.length > max) throw new HttpError(400, `В поле «${label}» можно ввести до ${max} символов.`);
  return trimmed;
}

function validateBook(data) {
  const title = field(data.title, 'Название', 120);
  const author = field(data.author, 'Автор', 100);
  const genre = field(data.genre, 'Жанр', 60);
  const description = field(data.description, 'Описание', 900, false);
  if (!Number.isInteger(data.year) || data.year < 1 || data.year > 9999) {
    throw new HttpError(400, 'Укажите год публикации от 1 до 9999.');
  }
  if (!Array.isArray(data.topics) || data.topics.length > 12 || data.topics.some(topic => typeof topic !== 'string')) {
    throw new HttpError(400, 'Укажите до 12 тем через запятую.');
  }
  const topics = data.topics.map(topic => field(topic, 'Темы', 45, false)).filter(Boolean);
  return { title, author, genre, description, year: data.year, topics };
}

function sessionToken(request) {
  return request.headers.cookie?.match(/(?:^|;\s*)library_parent=([a-f0-9]{64})(?:;|$)/)?.[1];
}

function verifyPin(pin) {
  if (typeof pin !== 'string' || !/^\d{4,12}$/.test(pin)) {
    throw new HttpError(400, 'PIN должен содержать от 4 до 12 цифр.');
  }
  const now = Date.now();
  attempts = attempts.filter(time => time > now - 60_000);
  if (attempts.length >= 6) throw new HttpError(429, 'Слишком много попыток. Попробуйте через минуту.');

  const newSalt = randomBytes(16).toString('hex');
  let saved = library.getPin();
  if (!saved) {
    library.setPin(newSalt, scryptSync(pin, newSalt, 64).toString('hex'));
    saved = library.getPin();
  }
  if (!timingSafeEqual(scryptSync(pin, saved.salt, 64), Buffer.from(saved.hash, 'hex'))) {
    attempts.push(now);
    throw new HttpError(401, 'Неверный PIN.');
  }
  attempts = [];
}

async function handleApi(request, response, path) {
  const method = request.method;
  const token = sessionToken(request);
  const parent = (sessions.get(token) ?? 0) > Date.now();

  if (method === 'GET' && path === '/api/library') {
    return json(response, 200, { parent, hasPin: Boolean(library.getPin()), books: library.books(parent) });
  }

  const origin = request.headers.origin;
  if (origin && origin !== `http://${request.headers.host}`) {
    throw new HttpError(403, 'Запрос пришёл с другого сайта.');
  }

  if (method === 'POST' && path === '/api/parent') {
    const { pin } = await readJson(request);
    verifyPin(pin);
    for (const [key, expires] of sessions) {
      if (expires <= Date.now() || key === token) sessions.delete(key);
    }
    const newToken = randomBytes(32).toString('hex');
    sessions.set(newToken, Date.now() + sessionDuration);
    response.setHeader('Set-Cookie', `library_parent=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDuration / 1000}`);
    return json(response, 200, { parent: true });
  }
  if (method === 'DELETE' && path === '/api/parent') {
    sessions.delete(token);
    response.setHeader('Set-Cookie', 'library_parent=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return json(response, 200, { parent: false });
  }

  if (!parent) throw new HttpError(403, 'Войдите в режим родителя, чтобы продолжить.');
  if (method === 'POST' && path === '/api/books') {
    const book = validateBook(await readJson(request));
    return json(response, 201, { id: library.addBook(book) });
  }
  if (method === 'DELETE' && path === '/api/examples') {
    library.clearExamples();
    return json(response, 200, { ok: true });
  }
  const bookRoute = path.match(/^\/api\/books\/([1-9]\d{0,14})\/loans$/);
  if (method === 'POST' && bookRoute) {
    const { borrower } = await readJson(request);
    const result = library.lend(Number(bookRoute[1]), field(borrower, 'Имя читателя', 100));
    if (result === 'missing') throw new HttpError(404, 'Этой книги больше нет в каталоге.');
    if (result === 'busy') throw new HttpError(409, 'Книга уже на руках. Сначала отметьте её возврат.');
    return json(response, 201, { ok: true });
  }
  const loanRoute = path.match(/^\/api\/loans\/([1-9]\d{0,14})\/return$/);
  if (method === 'POST' && loanRoute) {
    if (!library.returnBook(Number(loanRoute[1]))) throw new HttpError(409, 'Эта выдача уже закрыта.');
    return json(response, 200, { ok: true });
  }
  throw new HttpError(404, 'Этот адрес не найден.');
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  try {
    if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(request.headers.host ?? '')) {
      throw new HttpError(403, 'Откройте библиотеку с этого компьютера.');
    }
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.startsWith('/api/')) return await handleApi(request, response, path);
    const file = path === '/' ? 'index.html' : path.slice(1);
    const type = mime.get(file.split('.').at(-1));
    if (!['GET', 'HEAD'].includes(request.method) || !type || !/^(?:(?:art|fonts)\/)?[a-z0-9.-]+$/i.test(file)) {
      throw new HttpError(404, 'Этот адрес не найден.');
    }
    const content = await readFile(resolve(publicDir, file));
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (error instanceof HttpError) return json(response, error.status, { error: error.message });
    if (error.code === 'ENOENT') return json(response, 404, { error: 'Этот адрес не найден.' });
    console.error(error);
    json(response, 500, { error: 'Не удалось выполнить запрос. Попробуйте ещё раз.' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Библиотека открыта по адресу http://127.0.0.1:${server.address().port}`);
});
