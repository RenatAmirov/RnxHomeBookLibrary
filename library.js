import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const examples = [
  {
    title: 'Маленький принц', author: 'Антуан де Сент-Экзюпери', year: 1943,
    genre: 'Сказка', topics: ['Дружба', 'Космос', 'Путешествия'], cover: 'prince',
    description: 'Лётчик встречает в пустыне мальчика с далёкой планеты. Тот рассказывает о своей розе и о том, чему научился в путешествии.'
  },
  {
    title: 'Хоббит', author: 'Джон Р. Р. Толкин', year: 1937,
    genre: 'Фэнтези', topics: ['Приключения', 'Путешествия', 'Магия'], cover: 'hobbit',
    description: 'Бильбо Бэггинс покидает уютный дом и отправляется с гномами к Одинокой горе.'
  },
  {
    title: 'Космос', author: 'Карл Саган', year: 1980,
    genre: 'Научпоп', topics: ['Космос', 'Наука'], cover: 'cosmos',
    description: 'История Вселенной и человеческих открытий, которые помогли нам понять своё место в ней.'
  },
  {
    title: 'Алиса в Стране чудес', author: 'Льюис Кэрролл', year: 1865,
    genre: 'Сказка', topics: ['Приключения', 'Воображение', 'Магия'], cover: 'alice',
    description: 'Алиса бежит за Белым Кроликом и попадает в мир странных встреч, игр со словами и загадок.'
  }
];

function nameKey(name) {
  return name.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/\s+/gu, ' ');
}

export function openLibrary(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS genres (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      year INTEGER NOT NULL CHECK (year BETWEEN 1 AND 9999),
      genre_id INTEGER NOT NULL REFERENCES genres(id),
      description TEXT NOT NULL,
      cover TEXT,
      demo INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS book_topics (
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      topic_id INTEGER NOT NULL REFERENCES topics(id),
      PRIMARY KEY (book_id, topic_id)
    );
    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      borrower TEXT NOT NULL,
      lent_at TEXT NOT NULL,
      returned_at TEXT,
      demo INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_loan_per_book
      ON loans(book_id) WHERE returned_at IS NULL;
    CREATE TABLE IF NOT EXISTS parent_pin (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      salt TEXT NOT NULL,
      hash TEXT NOT NULL
    );
  `);

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const insertBook = db.prepare(`
    INSERT INTO books (title, author, year, genre_id, description, cover, demo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const connectTopic = db.prepare('INSERT OR IGNORE INTO book_topics VALUES (?, ?)');

  function namedEntry(table) {
    const insert = db.prepare(`INSERT INTO ${table} (name, name_key) VALUES (?, ?) ON CONFLICT(name_key) DO NOTHING`);
    const select = db.prepare(`SELECT id FROM ${table} WHERE name_key = ?`);
    return (name) => {
      const key = nameKey(name);
      insert.run(name, key);
      return select.get(key).id;
    };
  }

  const genreId = namedEntry('genres');
  const topicId = namedEntry('topics');

  function insertEdition({ title, author, year, genre, topics, description, cover = null }, demo) {
    const id = insertBook.run(title, author, year, genreId(genre), description, cover, demo).lastInsertRowid;
    for (const topic of topics) connectTopic.run(id, topicId(topic));
    return id;
  }

  transaction(() => {
    if (db.prepare('PRAGMA user_version').get().user_version !== 0) return;
    for (const book of [...examples].reverse()) {
      const id = insertEdition(book, 1);
      if (book.cover === 'hobbit') {
        db.prepare('INSERT INTO loans (book_id, borrower, lent_at, demo) VALUES (?, ?, ?, 1)')
          .run(id, 'Миша', new Date().toISOString());
      }
    }
    db.exec('PRAGMA user_version = 1');
  });

  const selectBooks = db.prepare(`
    SELECT b.id, b.title, b.author, b.year, b.description, b.cover, b.demo, g.name AS genre,
      l.id AS loanId, l.borrower, l.lent_at AS lentAt,
      (SELECT json_group_array(t.name) FROM book_topics AS bt
        JOIN topics AS t ON t.id = bt.topic_id WHERE bt.book_id = b.id) AS topics
    FROM books AS b
    JOIN genres AS g ON g.id = b.genre_id
    LEFT JOIN loans AS l ON l.book_id = b.id AND l.returned_at IS NULL
    ORDER BY b.id DESC
  `);
  const selectPin = db.prepare('SELECT salt, hash FROM parent_pin WHERE id = 1');
  const findBook = db.prepare('SELECT id FROM books WHERE id = ?');
  const insertLoan = db.prepare(`
    INSERT INTO loans (book_id, borrower, lent_at) VALUES (?, ?, ?)
    ON CONFLICT(book_id) WHERE returned_at IS NULL DO NOTHING
  `);
  const returnLoan = db.prepare('UPDATE loans SET returned_at = ? WHERE id = ? AND returned_at IS NULL');

  return {
    getPin: () => selectPin.get(),
    setPin: (salt, hash) => db.prepare('INSERT OR IGNORE INTO parent_pin VALUES (1, ?, ?)').run(salt, hash).changes === 1,
    books(parent) {
      return selectBooks.all().map(({ topics, loanId, borrower, lentAt, ...book }) => ({
        ...book,
        topics: JSON.parse(topics),
        available: loanId === null,
        ...(parent && loanId !== null ? { loan: { id: loanId, borrower, lentAt } } : {})
      }));
    },
    addBook: (book) => transaction(() => insertEdition(book, 0)),
    lend(id, borrower) {
      return transaction(() => {
        if (!findBook.get(id)) return 'missing';
        return insertLoan.run(id, borrower, new Date().toISOString()).changes === 1 ? 'lent' : 'busy';
      });
    },
    returnBook: (loanId) => returnLoan.run(new Date().toISOString(), loanId).changes === 1,
    clearExamples() {
      transaction(() => db.exec(`
        UPDATE books SET demo = 0 WHERE demo = 1 AND EXISTS (
          SELECT 1 FROM loans WHERE loans.book_id = books.id AND loans.demo = 0
        );
        DELETE FROM books WHERE demo = 1;
      `));
    }
  };
}
