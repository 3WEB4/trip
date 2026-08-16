/**
 * Comparison screen.
 *
 * Submits a job, polls its progress, and renders the ranked markets. Kept as
 * plain modules so the UI needs no build step — the server serves this file
 * as-is.
 */

/**
 * When the server runs with API_TOKEN set, the page needs to send it too.
 * Take it from `?token=` once and keep it locally, so the URL can be shared
 * without the token and a reload keeps working.
 */
const tokenFromUrl = new URLSearchParams(location.search).get('token');
if (tokenFromUrl) {
  localStorage.setItem('tripApiToken', tokenFromUrl);
  history.replaceState(null, '', location.pathname);
}

function authHeaders() {
  const token = localStorage.getItem('tripApiToken');
  return token ? { authorization: `Bearer ${token}` } : {};
}

const form = document.getElementById('compare-form');
const submitButton = document.getElementById('submit-button');
const formError = document.getElementById('form-error');
const marketGrid = document.getElementById('market-grid');
const progressCard = document.getElementById('progress-card');
const progressTitle = document.getElementById('progress-title');
const progressBar = document.getElementById('progress-bar');
const marketStatus = document.getElementById('market-status');
const resultSection = document.getElementById('result');
const demoBanner = document.getElementById('demo-banner');

const PHASE_LABELS = {
  queued: '順番待ち',
  fetching: '各市場の料金を取得中',
  matching: '同一プランを照合中',
  converting: '為替換算中',
  finished: '完了',
};

const STATE_LABELS = { pending: '待機', running: '取得中', done: '取得済', failed: '失敗' };

const MEAL_LABELS = {
  'room-only': '食事なし',
  breakfast: '朝食付き',
  'half-board': '2食付き',
  'full-board': '3食付き',
  'all-inclusive': 'オールインクルーシブ',
  unknown: '食事条件不明',
};

const CANCELLATION_LABELS = {
  free: '無料キャンセル可',
  'non-refundable': '返金不可',
  conditional: '条件付きキャンセル',
  unknown: 'キャンセル条件不明',
};

const PAYMENT_LABELS = { prepay: '事前決済', 'pay-at-hotel': '現地払い', unknown: '支払方法不明' };

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function clearError() {
  formError.hidden = true;
  formError.textContent = '';
}

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('ja-JP', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

async function loadMarkets() {
  const response = await fetch('/api/markets', { headers: authHeaders() });
  const body = await response.json();
  demoBanner.hidden = !body.demoMode;

  marketGrid.replaceChildren(
    ...body.markets.map((market) => {
      const label = document.createElement('label');
      label.className = 'market-toggle';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = market.code;
      input.checked = body.defaults.includes(market.code);

      const text = document.createElement('span');
      text.textContent = `${market.code}（${market.locale}）`;

      label.append(input, text);
      return label;
    }),
  );
}

function selectedMarkets() {
  return [...marketGrid.querySelectorAll('input:checked')].map((input) => input.value);
}

function renderProgress(job) {
  progressCard.hidden = false;
  const queued = job.state === 'queued';
  progressTitle.textContent = queued
    ? `順番待ち（${job.queuePosition}件待ち）`
    : PHASE_LABELS[job.progress.phase] ?? '比較中';
  progressBar.style.width = `${job.progress.percent}%`;

  marketStatus.replaceChildren(
    ...job.progress.markets.map((entry) => {
      const item = document.createElement('li');

      const chip = document.createElement('span');
      chip.className = `status-chip ${entry.state}`;
      chip.textContent = STATE_LABELS[entry.state] ?? entry.state;

      const name = document.createElement('strong');
      name.textContent = entry.market;

      const note = document.createElement('span');
      note.textContent = entry.note ?? '';

      item.append(chip, name, note);
      return item;
    }),
  );
}

function conditionsText(price) {
  return [MEAL_LABELS[price.meal], CANCELLATION_LABELS[price.cancellation], PAYMENT_LABELS[price.payment]]
    .filter(Boolean)
    .join(' / ');
}

function renderResult(result) {
  resultSection.hidden = false;

  document.getElementById('hotel-name').textContent = result.hotel.name ?? `ホテル ID ${result.hotel.hotelId}`;
  document.getElementById('stay-summary').textContent =
    `${result.hotel.checkIn} 〜 ${result.hotel.checkOut} ／ 大人${result.hotel.adult}名` +
    `${result.hotel.children > 0 ? `・子供${result.hotel.children}名` : ''}／${result.hotel.roomQuantity}室`;

  const headline = document.getElementById('headline');
  const baseline = result.prices.find((price) => price.market === 'JP');
  const cheapest = result.prices[0];

  if (!cheapest) {
    headline.textContent = '比較できる同一プランが見つかりませんでした。';
  } else if (baseline && cheapest.market !== baseline.market) {
    const saving = baseline.convertedPrice - cheapest.convertedPrice;
    headline.innerHTML =
      `最安は <strong>${cheapest.market}</strong>。日本より ` +
      `<span class="amount">${formatMoney(saving, result.targetCurrency)}</span> 安い。`;
  } else {
    headline.textContent = `最安は ${cheapest.market}。この条件では日本が最安です。`;
  }

  const matched = result.matchedOn;
  document.getElementById('matched-on').textContent = matched
    ? `照合キー: roomCode ${matched.roomCode ?? '—'} / roomId ${matched.roomId ?? '—'} / physicalRoomId ${matched.physicalRoomId ?? '—'}`
    : '';

  const rows = result.prices.map((price, index) => {
    const row = document.createElement('tr');
    if (index === 0) row.className = 'cheapest';

    const marketCell = document.createElement('td');
    marketCell.className = 'market-header-cell';
    const marketWrap = document.createElement('div');
    marketWrap.className = 'market-cell';
    const marketName = document.createElement('strong');
    marketName.textContent = price.market;
    marketWrap.append(marketName);
    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '最安';
      marketWrap.append(badge);
    }
    marketCell.append(marketWrap);

    const priceCell = document.createElement('td');
    priceCell.className = 'numeric';
    priceCell.dataset.label = '料金';
    priceCell.textContent = formatMoney(price.convertedPrice, price.targetCurrency);
    if (price.currency !== price.targetCurrency) {
      const original = document.createElement('div');
      original.className = 'conditions';
      original.textContent = `現地表示 ${formatMoney(price.originalPrice, price.currency)}`;
      priceCell.append(original);
    }

    const deltaCell = document.createElement('td');
    deltaCell.className = 'numeric';
    deltaCell.dataset.label = '日本との差';
    if (baseline && price.market !== 'JP') {
      const delta = price.convertedPrice - baseline.convertedPrice;
      deltaCell.textContent = `${delta > 0 ? '+' : ''}${formatMoney(delta, price.targetCurrency)}`;
      deltaCell.classList.add(delta < 0 ? 'delta-cheaper' : 'delta-pricier');
    } else {
      deltaCell.textContent = baseline ? '基準' : '—';
    }

    const conditionCell = document.createElement('td');
    conditionCell.className = 'conditions';
    conditionCell.dataset.label = '条件';
    conditionCell.textContent = conditionsText(price);

    const linkCell = document.createElement('td');
    linkCell.className = 'booking-cell';
    const link = document.createElement('a');
    link.href = price.bookingUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${price.market}のサイトで開く`;
    linkCell.append(link);

    row.append(marketCell, priceCell, deltaCell, conditionCell, linkCell);
    return row;
  });

  document.getElementById('price-rows').replaceChildren(...rows);

  const notes = [];
  if (result.matchQuality?.confidence === 'probable') {
    notes.push('一部の市場が条件を返さなかったため、完全一致ではない可能性があります。');
  }
  for (const failure of result.failures) {
    notes.push(
      `${failure.market}: 取得失敗（${failure.reason}）` +
        `${failure.manualActionRequired ? ' — CAPTCHA等のため手動対応が必要です。' : ''}`,
    );
  }
  if (result.unmatchedMarkets.length > 0) {
    notes.push(`同一プランが見つからなかった市場: ${result.unmatchedMarkets.join(', ')}（在庫切れの可能性）`);
  }
  const notesElement = document.getElementById('notes');
  notesElement.textContent = notes.join('\n');
  notesElement.hidden = notes.length === 0;
}

async function pollJob(id) {
  for (;;) {
    const response = await fetch(`/api/jobs/${id}`, { headers: authHeaders() });
    if (!response.ok) throw new Error('ジョブの状態を取得できませんでした。');
    const job = await response.json();
    renderProgress(job);

    if (job.state === 'succeeded') return job.result;
    if (job.state === 'failed') throw new Error(job.error?.message ?? '比較に失敗しました。');

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const markets = selectedMarkets();
  if (markets.length === 0) {
    showError('比較する市場を1つ以上選んでください。');
    return;
  }

  resultSection.hidden = true;
  submitButton.disabled = true;
  submitButton.textContent = '比較中…';

  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        tripUrl: document.getElementById('trip-url').value,
        markets,
        targetCurrency: document.getElementById('currency').value,
        samples: Number(document.getElementById('samples').value),
      }),
    });

    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.message ?? `リクエストが拒否されました（${body.error ?? response.status}）。`);
    }

    renderProgress(body);
    const result = await pollJob(body.id);
    renderResult(result);
  } catch (error) {
    showError(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = '比較する';
  }
});

loadMarkets().catch(() =>
  showError('市場一覧を読み込めませんでした。認証が有効な場合は ?token=<APIトークン> を付けて開いてください。'),
);
