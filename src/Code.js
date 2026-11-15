/**
 * Google カレンダーにある今後のセッション予定を、月ごとにまとめて Discord に投稿する。
 *
 * 秘密情報や個人に合わせた設定はコードに書かず、スクリプトプロパティ
 * （エディタ左の「プロジェクトの設定」>「スクリプト プロパティ」）に登録する。
 *
 *   CALENDAR_ID               必須  セッション予定を入れているカレンダーの ID
 *   DISCORD_WEBHOOK_URL_PROD  必須  本番チャンネルの Webhook URL
 *   DISCORD_WEBHOOK_URL_TEST  任意  テストチャンネルの Webhook URL
 *   GM_KEYWORD                任意  予定の説明にこの文字列があれば GM、なければ PL と表示する
 *                                   （未設定なら GM / PL を表示しない）
 *   FOOTER_TITLE              任意  末尾に載せる案内の見出し（初期値：📌 お知らせ）
 *   FOOTER_URL                任意  末尾に載せるリンク
 *   FOOTER_TEXT               任意  末尾に載せる文章（\n と書いた部分で改行する）
 *
 * 初回は setupMonthlyTrigger() を一度手動実行して、月次トリガーを登録する。
 */

// ===== 設定 =====
const TIME_ZONE = 'Asia/Tokyo';
const MONTHS = 6; // 今月から何か月分を載せるか
const TRIGGER_DAY = 1; // 毎月この日に実行
const TRIGGER_HOUR = 9; // この時台に実行

const EMBED_TITLE = '🎲 セッション予定';
const EMBED_COLOR = 0x5865f2;
const DEFAULT_FOOTER_TITLE = '📌 お知らせ';

// Discord の上限（項目の本文 1024 文字、項目数 25、1 つの埋め込み全体 6000 文字）より少し小さくしておく
const DISCORD_FIELD_VALUE_LIMIT = 1000;
const DISCORD_MAX_FIELDS = 25;
const DISCORD_EMBED_LIMIT = 5500;
const DISCORD_MAX_ATTEMPTS = 3;

const BLANK_LINE = '\n​'; // 項目の間に空行を入れるための見えない文字

// ===== エントリーポイント =====

/** 月次トリガーから呼ばれる本番用。 */
function sendTRPGScheduleToDiscord() {
  run_(getRequiredProperty_('DISCORD_WEBHOOK_URL_PROD'));
}

/** テストチャンネルに同じ内容を投稿する。 */
function testSendTRPGScheduleToDiscord() {
  run_(getRequiredProperty_('DISCORD_WEBHOOK_URL_TEST'));
}

/** 本番用関数の月次トリガーを登録し直す。手動で一度だけ実行する。 */
function setupMonthlyTrigger() {
  const handler = 'sendTRPGScheduleToDiscord';

  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === handler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger(handler)
    .timeBased()
    .onMonthDay(TRIGGER_DAY)
    .atHour(TRIGGER_HOUR)
    .inTimezone(TIME_ZONE)
    .create();

  console.log(`トリガーを登録しました：毎月${TRIGGER_DAY}日 ${TRIGGER_HOUR}時台（${TIME_ZONE}）に ${handler} を実行`);
}

// ===== 本体 =====

function run_(webhookUrl) {
  const calendarId = getRequiredProperty_('CALENDAR_ID');
  const calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) {
    throw new Error(`カレンダー「${calendarId}」が見つかりません。CALENDAR_ID と、カレンダーへのアクセス権を確認してください。`);
  }

  const { start, end } = getRange_(new Date());
  const months = groupByMonth_(calendar.getEvents(start, end));
  console.log(`対象期間：${formatDate_(start)} ～ ${formatDate_(end)}（終了日は含まない）`);
  months.forEach(month => console.log(`${month.label}：${month.lines.length}件`));

  sendDiscord_(webhookUrl, createEmbeds_(months));
}

/** 今月1日から MONTHS か月後の1日まで（終了日は含まない）。 */
function getRange_(now) {
  const [year, month] = Utilities.formatDate(now, TIME_ZONE, 'yyyy-M').split('-').map(Number);
  return {
    start: new Date(year, month - 1, 1),
    end: new Date(year, month - 1 + MONTHS, 1),
  };
}

function formatDate_(date) {
  return Utilities.formatDate(date, TIME_ZONE, 'yyyy-MM-dd');
}

/** 予定を月ごとにまとめ、同じ月の同じ予定（タイトルと GM / PL が同じもの）は1件にする。 */
function groupByMonth_(events) {
  const gmKeyword = getOptionalProperty_('GM_KEYWORD');
  const months = new Map();

  events.forEach(event => {
    const startTime = event.getStartTime();
    const key = Utilities.formatDate(startTime, TIME_ZONE, 'yyyyMM');
    if (!months.has(key)) {
      months.set(key, {
        label: Utilities.formatDate(startTime, TIME_ZONE, 'yyyy年M月'),
        lines: new Set(),
      });
    }

    const title = event.getTitle().trim();
    let line = `・${title}`;
    if (gmKeyword) {
      const role = (event.getDescription() || '').includes(gmKeyword) ? 'GM' : 'PL';
      line += `（${role}）`;
    }
    months.get(key).lines.add(line);
  });

  return [...months.keys()]
    .sort()
    .map(key => ({ label: months.get(key).label, lines: [...months.get(key).lines] }));
}

// ===== メッセージ作成 =====

function createEmbeds_(months) {
  const fields = [];
  months.forEach(month => {
    splitByLines_(month.lines.join('\n'), DISCORD_FIELD_VALUE_LIMIT).forEach((chunk, index) => {
      fields.push({
        name: index === 0 ? `📅 ${month.label}` : `📅 ${month.label}（続き）`,
        value: chunk + BLANK_LINE,
      });
    });
  });

  const footer = createFooterField_();
  if (footer) {
    fields.push(footer);
  }

  const description = months.length === 0
    ? `今後${MONTHS}か月のTRPG予定はありません。`
    : `今後${MONTHS}か月分のTRPG予定をまとめました。`;

  // 上限を超える場合は、埋め込みを分けて複数回投稿する
  const embeds = [];
  let current = null;
  fields.forEach(field => {
    const size = field.name.length + field.value.length;
    if (!current || current.fields.length >= DISCORD_MAX_FIELDS || current.size + size > DISCORD_EMBED_LIMIT) {
      current = { fields: [], size: 0 };
      embeds.push(current);
    }
    current.fields.push(field);
    current.size += size;
  });
  if (embeds.length === 0) {
    embeds.push({ fields: [], size: 0 });
  }

  return embeds.map((embed, index) => {
    const result = { color: EMBED_COLOR, fields: embed.fields };
    if (index === 0) {
      result.title = EMBED_TITLE;
      result.description = description + BLANK_LINE;
    }
    return result;
  });
}

function createFooterField_() {
  const url = getOptionalProperty_('FOOTER_URL');
  // 入力欄では改行できないので、\n と書かれた部分を改行にする
  const text = (getOptionalProperty_('FOOTER_TEXT') || '').replace(/\\n/g, '\n');
  if (!url && !text) {
    return null;
  }

  const parts = [];
  if (url) {
    parts.push(`<${url}>`);
  }
  if (text) {
    parts.push('```' + text + '```');
  }
  return {
    name: getOptionalProperty_('FOOTER_TITLE') || DEFAULT_FOOTER_TITLE,
    value: parts.join('\n').substring(0, 1024),
  };
}

function splitByLines_(text, limit) {
  const chunks = [];
  let current = '';
  text.split('\n').forEach(line => {
    if (current && current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line.substring(0, limit);
  });
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

// ===== Discord =====

function sendDiscord_(webhookUrl, embeds) {
  embeds.forEach(embed => postToDiscord_(webhookUrl, { embeds: [embed] }));
}

/** Apps Script は IP を共有しているため 429 が返りやすい。待ってから再送する。 */
function postToDiscord_(webhookUrl, payload) {
  for (let attempt = 1; ; attempt++) {
    const response = UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();

    if (code >= 200 && code < 300) {
      return;
    }
    if (code !== 429 || attempt >= DISCORD_MAX_ATTEMPTS) {
      throw new Error(`Discord error ${code}: ${response.getContentText().substring(0, 500)}`);
    }

    const headers = response.getHeaders();
    const retryAfterSec = Number(headers['Retry-After'] || headers['retry-after']) || attempt * 5;
    console.log(`Discord から 429 が返ったため ${retryAfterSec} 秒後に再送します（${attempt}/${DISCORD_MAX_ATTEMPTS}）`);
    Utilities.sleep(Math.min(retryAfterSec, 60) * 1000);
  }
}

// ===== 共通 =====

function getRequiredProperty_(key) {
  const value = getOptionalProperty_(key);
  if (!value) {
    throw new Error(`スクリプトプロパティ「${key}」が設定されていません。`);
  }
  return value;
}

function getOptionalProperty_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}
