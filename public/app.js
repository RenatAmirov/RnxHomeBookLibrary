const $ = (id) => document.getElementById(id);
const dialog = $('dialog');
const dialogContent = $('dialog-content');
const search = $('search');
const genre = $('genre');
const topic = $('topic');
const sort = $('sort');
const pages = { catalog: 'Каталог', topics: 'Темы', loans: 'Выдачи' };
const knownCovers = new Set(['prince', 'hobbit', 'cosmos', 'alice']);
const collator = new Intl.Collator('ru', { numeric: true });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
let catalog = { parent: false, hasPin: false, books: [] };
let loaded = false;
let loadError = '';
let modal;
let submitting = false;
let noticeTimer;

function escape(value) {
  return String(value).replace(/[&<>"']/g, (character) => entities[character]);
}

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function normalize(text) {
  return text.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е').trim();
}

function page() {
  const hash = location.hash.slice(1);
  return Object.hasOwn(pages, hash) ? hash : 'catalog';
}

function navigate(name) {
  if (page() !== name || !location.hash) location.hash = name;
  else renderPage();
}

function button(label, action, { appearance = 'primary', symbol, value } = {}) {
  return `<button class="button ${appearance}" type="button" data-action="${action}"${value === undefined ? '' : ` data-value="${escape(value)}"`}>${symbol ? icon(symbol) : ''}${escape(label)}</button>`;
}

function empty(symbol, title, copy = '', action = '') {
  return `<div class="empty">${icon(symbol)}<h3>${escape(title)}</h3>${copy ? `<p>${escape(copy)}</p>` : ''}${action}</div>`;
}

function notice(message, isError = false) {
  const element = $('notice');
  clearTimeout(noticeTimer);
  element.classList.toggle('error', isError);
  element.innerHTML = `${icon(isError ? 'close' : 'check')}<span>${escape(message)}</span>`;
  element.hidden = false;
  noticeTimer = setTimeout(() => { element.hidden = true; }, 4200);
}

async function api(path, method = 'GET', data) {
  let response;
  try {
    response = await fetch(`/api/${path}`, {
      method,
      ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    });
  } catch {
    throw new Error('Связь с библиотекой потеряна. Проверьте, запущен ли сервер.');
  }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}

async function refresh() {
  try {
    catalog = await api('library');
    loadError = '';
  } catch (error) {
    loadError = error.message;
  }
  loaded = true;
  renderPage();
  return !loadError;
}

function updateOptions(select, label, names) {
  const previous = select.value;
  select.replaceChildren(new Option(label, ''), ...names.map(name => new Option(name, name)));
  select.value = names.includes(previous) ? previous : '';
}

function cover(book) {
  const artwork = knownCovers.has(book.cover) ? book.cover : 'plain';
  return `<span class="cover-stage tone-${artwork}" aria-hidden="true"><span class="cover cover-${artwork}">
    <span class="cover-author">${escape(book.author)}</span>
    <span class="cover-title">${escape(book.title)}</span>
    ${artwork === 'plain' ? icon('open') : ''}
  </span></span>`;
}

function status(book) {
  return book.available ? '<span class="status">На полке</span>' : '<span class="status lent">На руках</span>';
}

function bookCard(book) {
  return `<button type="button" class="book-card" data-action="book" data-value="${book.id}" aria-label="${escape(book.title)}, ${escape(book.author)}, ${book.available ? 'на полке' : 'на руках'}">
    ${cover(book)}
    <span class="book-copy">
      <span class="book-title">${escape(book.title)}</span>
      <span class="book-author">${escape(book.author)}</span>
      <span class="book-meta">${escape(book.genre)} · ${book.year}</span>
      <span class="book-status">${status(book)}</span>
    </span>
  </button>`;
}

function renderCatalog() {
  const list = $('book-list');
  list.setAttribute('aria-busy', String(!loaded));
  if (!loaded) return;
  if (loadError) {
    $('result-count').textContent = '…';
    list.innerHTML = empty('book', 'Каталог недоступен', loadError, button('Повторить', 'reload'));
    return;
  }
  const words = normalize(search.value).split(/\s+/u).filter(Boolean);
  const books = catalog.books.filter(book => {
    const searchable = normalize([book.title, book.author, book.genre, ...book.topics].join(' '));
    return (!genre.value || book.genre === genre.value) && (!topic.value || book.topics.includes(topic.value)) &&
      words.every(word => searchable.includes(word));
  });
  if (sort.value === 'title') books.sort((a, b) => collator.compare(a.title, b.title));
  if (sort.value === 'year') books.sort((a, b) => b.year - a.year || collator.compare(a.title, b.title));

  const filtered = Boolean(words.length || genre.value || topic.value);
  $('results-title').textContent = topic.value ? `Тема «${topic.value}»` : filtered ? 'Результаты поиска' : 'Все книги';
  $('result-count').textContent = String(books.length);
  $('result-count').setAttribute('aria-label', `Найдено книг — ${books.length}`);
  if (books.length) list.innerHTML = books.map(bookCard).join('');
  else if (filtered) {
    list.innerHTML = empty('search', 'Книги не найдены', 'Измените запрос или сбросьте фильтры.', button('Сбросить фильтры', 'reset', { appearance: 'secondary' }));
  } else {
    list.innerHTML = empty('open', 'Полка пока пуста', 'Добавьте первое издание в каталог.', button('Добавить книгу', 'add', { symbol: 'plus' }));
  }
}

function renderTopics() {
  const counts = new Map();
  for (const book of catalog.books) {
    for (const name of book.topics) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  $('topic-list').innerHTML = counts.size
    ? [...counts].sort(([a], [b]) => collator.compare(a, b)).map(([name, count]) => `
      <button class="topic-card" type="button" data-action="topic" data-value="${escape(name)}">
        ${icon('tag')}<span class="count" aria-label="Книг — ${count}">${count}</span><strong>${escape(name)}</strong>${icon('right')}
      </button>`).join('')
    : empty('tag', 'Тем пока нет', 'Темы появятся здесь, когда их укажут в карточках книг.');
}

function renderLoans() {
  const list = $('loan-list');
  if (!catalog.parent) {
    list.innerHTML = empty('lock', 'Раздел для родителей', 'Войдите, чтобы посмотреть выдачи и отметить возврат.', button('Войти как родитель', 'mode', { symbol: 'lock' }));
    return;
  }
  const loans = catalog.books.filter(book => book.loan).sort((a, b) => b.loan.lentAt.localeCompare(a.loan.lentAt));
  list.innerHTML = loans.length ? loans.map(book => `
    <article class="loan-row">
      <button class="text-button loan-title" type="button" data-action="book" data-value="${book.id}">${escape(book.title)}</button>
      <div class="loan-info">${escape(book.loan.borrower)}<br><small>${escape(dateFormat.format(new Date(book.loan.lentAt)))}</small></div>
      ${button('Отметить возврат', 'return', { appearance: 'secondary', symbol: 'return', value: book.id })}
    </article>`).join('') : empty('book', 'Все книги на полке', 'Чтобы выдать книгу, откройте её карточку в каталоге.', '<a class="button secondary" href="#catalog">Перейти в каталог</a>');
}

function renderPage() {
  const current = page();
  for (const name of Object.keys(pages)) {
    $(`${name}-page`).hidden = current !== name;
    const link = document.querySelector(`.navigation a[href="#${name}"]`);
    if (current === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('page-name').textContent = pages[current];
  $('profile-label').textContent = catalog.parent ? 'Режим родителя' : 'Режим ребёнка';
  $('mode-button').innerHTML = catalog.parent ? `${icon('user')}<span>Режим ребёнка</span>` : `${icon('lock')}<span>Режим родителя</span>`;
  $('clear-examples').hidden = !catalog.parent || !catalog.books.some(book => book.demo);
  if (loaded && !loadError) {
    updateOptions(genre, 'Все жанры', [...new Set(catalog.books.map(book => book.genre))].sort(collator.compare));
    updateOptions(topic, 'Все темы', [...new Set(catalog.books.flatMap(book => book.topics))].sort(collator.compare));
  }
  if (current === 'catalog') renderCatalog();
  else if (loaded) {
    if (loadError) {
      $(current === 'topics' ? 'topic-list' : 'loan-list').innerHTML = empty('book', 'Раздел недоступен', loadError, button('Повторить', 'reload'));
    } else if (current === 'topics') renderTopics();
    else renderLoans();
  }
}

function resetFilters() {
  search.value = '';
  genre.value = '';
  topic.value = '';
}

function chooseTopic(name) {
  if (dialog.open) dialog.close();
  resetFilters();
  topic.value = name;
  navigate('catalog');
}

function openDialog(kind, title, body, data = {}) {
  modal = { kind, ...data };
  dialogContent.innerHTML = `<div class="dialog-top"><h2 id="dialog-title">${escape(title)}</h2>
    <button class="icon-button" type="button" data-action="close" aria-label="Закрыть">${icon('close')}</button></div>${body}`;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('[autofocus]')?.focus();
}

function formActions(label) {
  return `<p class="form-error" role="alert" hidden></p><div class="dialog-actions">
    ${button('Отмена', 'close', { appearance: 'secondary' })}<button class="button primary" type="submit">${escape(label)}</button>
  </div>`;
}

function openPin(next) {
  const setup = !catalog.hasPin;
  openDialog('pin', setup ? 'Создайте PIN родителя' : 'Режим родителя', `
    <p class="dialog-copy">${setup ? 'Придумайте PIN из 4–12 цифр для добавления книг и управления выдачами.' : 'Введите PIN, чтобы управлять библиотекой.'}</p>
    <form>
      <div class="form-fields"><label class="full">PIN<input autofocus type="password" name="pin" inputmode="numeric" autocomplete="${setup ? 'new-password' : 'current-password'}" pattern="[0-9]{4,12}" minlength="4" maxlength="12" required></label>
      ${setup ? '<label class="full">Повторите PIN<input type="password" name="confirmation" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{4,12}" minlength="4" maxlength="12" required></label>' : ''}</div>
      ${formActions(setup ? 'Создать PIN' : 'Войти')}
    </form>`, { next, setup });
}

function requireParent(next) {
  if (catalog.parent) next();
  else openPin(next);
}

function openAdd() {
  const genres = [...new Set(catalog.books.map(book => book.genre))].sort(collator.compare);
  openDialog('add', 'Добавить книгу', `<form>
    <div class="form-fields">
      <label class="full">Название<input name="title" maxlength="120" required autofocus></label>
      <label class="full">Автор<input name="author" maxlength="100" required></label>
      <label>Жанр<input name="genre" list="known-genres" maxlength="60" required></label>
      <datalist id="known-genres">${genres.map(name => `<option value="${escape(name)}"></option>`).join('')}</datalist>
      <label>Год публикации<input type="number" name="year" inputmode="numeric" min="1" max="9999" required></label>
      <label class="full">Темы<input name="topics" maxlength="565" placeholder="Например, дружба, космос"><small>До 12 тем через запятую</small></label>
      <label class="full">Описание<textarea name="description" rows="2" maxlength="900" placeholder="По желанию"></textarea></label>
    </div>${formActions('Добавить книгу')}</form>`);
}

function openBook(book) {
  const management = book.available
    ? button('Выдать книгу', 'lend', { symbol: 'loan', value: book.id })
    : button('Отметить возврат', 'return', { symbol: 'return', value: book.id });
  openDialog('detail', book.title, `
    <div class="detail">${cover(book)}<div class="detail-copy">
      <p>${escape(book.author)}</p><p class="book-meta">${escape(book.genre)} · ${book.year}</p>${status(book)}
      ${book.loan ? `<p>У читателя <strong>${escape(book.loan.borrower)}</strong><br><small>${escape(dateFormat.format(new Date(book.loan.lentAt)))}</small></p>` : ''}
    </div></div>
    ${book.description ? `<p class="description">${escape(book.description)}</p>` : ''}
    ${book.topics.length ? `<div class="detail-topics" aria-label="Темы книги">${book.topics.map(name => `<button type="button" class="topic-chip" data-action="topic" data-value="${escape(name)}">${escape(name)}</button>`).join('')}</div>` : ''}
    <div class="dialog-actions">${catalog.parent ? management : button('Закрыть', 'close', { appearance: 'secondary' })}</div>`);
}

function openLoan(book) {
  openDialog('lend', 'Выдать книгу', `<p class="dialog-copy">${escape(book.title)}</p>
    <form><div class="form-fields"><label class="full">Имя читателя<input name="borrower" required autofocus maxlength="100"></label></div>${formActions('Подтвердить выдачу')}</form>`, { book });
}

function openReturn(book) {
  openDialog('return', 'Отметить возврат', `<p class="dialog-copy">Вернуть «${escape(book.title)}» на полку?</p>
    <form>${formActions('Подтвердить возврат')}</form>`, { book });
}

function openExamples() {
  openDialog('examples', 'Убрать примеры из каталога?', `<p class="dialog-copy">Демонстрационные книги без ваших выдач будут удалены.</p>
    <form>${formActions('Убрать примеры')}</form>`);
}

async function changeMode() {
  if (!catalog.parent) return openPin();
  const modeButton = $('mode-button');
  modeButton.disabled = true;
  try {
    await api('parent', 'DELETE');
    catalog.parent = false;
    await refresh();
    notice('Включён режим ребёнка');
  } catch (error) {
    notice(error.message, true);
  } finally {
    modeButton.disabled = false;
  }
}

async function submit(form) {
  if (submitting) return;
  submitting = true;
  const data = Object.fromEntries(new FormData(form));
  const feedback = form.querySelector('.form-error');
  const submitButton = form.querySelector('button[type="submit"]');
  const { kind, book, next, setup } = modal;
  feedback.hidden = true;
  submitButton.disabled = true;
  try {
    let message;
    switch (kind) {
      case 'pin':
        if (setup && data.pin !== data.confirmation) throw new Error('PIN и его подтверждение различаются.');
        await api('parent', 'POST', { pin: data.pin });
        message = 'Включён режим родителя';
        break;
      case 'add':
        await api('books', 'POST', { ...data, year: Number(data.year), topics: data.topics.split(',').map(name => name.trim()).filter(Boolean) });
        resetFilters();
        sort.value = 'new';
        navigate('catalog');
        message = 'Книга добавлена';
        break;
      case 'lend':
        await api(`books/${book.id}/loans`, 'POST', { borrower: data.borrower });
        message = 'Выдача записана';
        break;
      case 'return':
        await api(`loans/${book.loan.id}/return`, 'POST');
        message = 'Возврат записан';
        break;
      case 'examples':
        await api('examples', 'DELETE');
        message = 'Примеры убраны из каталога';
        break;
    }
    const ready = await refresh();
    if (ready && next) next();
    else dialog.close();
    notice(message);
  } catch (error) {
    if (error.status === 409 || error.status === 403) await refresh();
    feedback.textContent = error.message;
    feedback.hidden = false;
  } finally {
    submitting = false;
    submitButton.disabled = false;
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || submitting) return;
  const { action, value } = target.dataset;
  const book = ['book', 'lend', 'return'].includes(action) ? catalog.books.find(entry => entry.id === Number(value)) : null;
  switch (action) {
    case 'close': dialog.close(); break;
    case 'reload': refresh(); break;
    case 'mode': changeMode(); break;
    case 'add': requireParent(openAdd); break;
    case 'examples': requireParent(openExamples); break;
    case 'book': if (book) openBook(book); break;
    case 'lend': if (book?.available) requireParent(() => openLoan(book)); break;
    case 'return': if (book?.loan) requireParent(() => openReturn(book)); break;
    case 'topic': chooseTopic(value); break;
    case 'reset': resetFilters(); renderCatalog(); search.focus(); break;
  }
});

dialog.addEventListener('submit', (event) => {
  event.preventDefault();
  submit(event.target);
});
dialog.addEventListener('cancel', (event) => { if (submitting) event.preventDefault(); });
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  $('main-content').focus();
});
window.addEventListener('hashchange', () => {
  renderPage();
  window.scrollTo(0, 0);
});
search.addEventListener('input', renderCatalog);
for (const select of [genre, topic, sort]) select.addEventListener('change', renderCatalog);

renderPage();
refresh();
