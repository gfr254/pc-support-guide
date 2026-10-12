import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const required = [
  "OPENAI_API_KEY",
  "HATENA_USER_ID",
  "HATENA_API_KEY",
  "HATENA_PC_BLOG_ID",
];
for (const key of required) {
  if (!process.env[key]) throw new Error("Missing required Actions secret: " + key);
}

const allowedHosts = new Set([
  "support.microsoft.com",
  "support.apple.com",
  "support.google.com",
  "www.ipa.go.jp",
  "www.jpcert.or.jp",
]);
const safeTitle = (value) =>
  String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ja");
const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const decodeXml = (value) =>
  String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

function getJstDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function isPlainText(body) {
  return (
    typeof body === "string" &&
    body.length >= 700 &&
    body.length <= 6000 &&
    !/^\s*#{1,6}\s/m.test(body) &&
    !/^\s*[-*+]\s/m.test(body) &&
    !/\*\*|__|`|\[[^\]]+\]\([^)]*\)/.test(body)
  );
}

async function verifySources(sources) {
  if (!Array.isArray(sources) || sources.length < 2 || sources.length > 4) {
    throw new Error("Article needs 2-4 official sources");
  }
  for (const source of sources) {
    const url = new URL(source.url);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
      throw new Error("Unapproved source host: " + url.hostname);
    }
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "PCSupportGuidePublisher/1.0" },
    });
    const finalHost = new URL(response.url).hostname;
    await response.body?.cancel();
    if (!response.ok || !allowedHosts.has(finalHost)) {
      throw new Error(
        "Official source could not be verified: " +
          url.hostname +
          " HTTP " +
          response.status,
      );
    }
  }
}

async function generateArticle(date) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "あなたは初心者向けPCサポート記事の編集者です。日本語の完成記事を作り、JSONのみ返します。",
            "記事本文はMarkdown記法を一切使わないプレーンテキストです。見出し記号、箇条書き記号、太字記号、コード記号、Markdownリンクは禁止。段落と通常の文章だけを使い、700〜6000文字にします。",
            "初期化、分解、レジストリ変更、管理者コマンド、セキュリティ解除、遠隔操作、パスワード共有を勧めないでください。会社や学校の端末は管理者へ相談するよう案内してください。",
            "個人情報や勤務先・顧客の事例は使わないでください。既存記事の起動しない、Wi-Fi不通、偽ウイルス警告とは重複しないテーマにします。",
            "sourcesにはMicrosoft、Apple、Google、IPA、JPCERT/CCの公式ページだけを2〜4件挙げ、実在を確信できるURLを使います。架空URLは禁止です。",
            'JSON形式: {"title":"記事タイトル","summary":"短い説明","body":"記事本文","tags":["タグ"],"sources":[{"title":"資料名","url":"https://公式URL"}]}',
          ].join("\n"),
        },
        {
          role: "user",
          content:
            "作成日:" +
            date +
            "。設定変更前に安全に確認できる、既存記事と重複しない記事を1本作成してください。",
        },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error("OpenAI request failed: HTTP " + response.status);
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error("OpenAI returned no article");
  const article = JSON.parse(raw);
  if (
    typeof article.title !== "string" ||
    article.title.trim().length < 8 ||
    article.title.length > 100 ||
    typeof article.summary !== "string" ||
    !isPlainText(article.body) ||
    !Array.isArray(article.tags) ||
    article.tags.length > 8 ||
    !article.tags.every((tag) => typeof tag === "string")
  ) {
    throw new Error("Generated article failed validation");
  }
  await verifySources(article.sources);
  const body =
    article.body.trim() +
    "\n\n参考にした公式資料\n" +
    article.sources
      .map((source) => source.title + "\n" + source.url)
      .join("\n\n");
  return {
    date,
    title: article.title.trim(),
    summary: article.summary.trim(),
    body,
    tags: article.tags,
    sources: article.sources,
  };
}

function commit(paths, message) {
  execFileSync("git", ["config", "user.name", "github-actions[bot]"]);
  execFileSync("git", [
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  execFileSync("git", ["add", ...paths]);
  try {
    execFileSync("git", ["commit", "-m", message], { stdio: "ignore" });
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  execFileSync("git", ["push"]);
}

async function publish(article) {
  const blogId = process.env.HATENA_PC_BLOG_ID.trim();
  if (!/^[a-z0-9-]+\.hatenablog\.com$/i.test(blogId)) {
    throw new Error("HATENA_PC_BLOG_ID must be the PC blog hostname");
  }
  const userId = process.env.HATENA_USER_ID.trim();
  const endpoint =
    "https://blog.hatena.ne.jp/" +
    encodeURIComponent(userId) +
    "/" +
    encodeURIComponent(blogId) +
    "/atom/entry";
  const authorization =
    "Basic " +
    Buffer.from(userId + ":" + process.env.HATENA_API_KEY.trim()).toString("base64");
  const feed = await fetch(endpoint, {
    headers: { Accept: "application/atom+xml", Authorization: authorization },
    signal: AbortSignal.timeout(15000),
  });
  if (!feed.ok) throw new Error("Hatena duplicate-check failed: HTTP " + feed.status);
  const xml = await feed.text();
  if (!/<feed\b/i.test(xml)) {
    throw new Error("Hatena feed could not be parsed; refusing to publish");
  }
  const titles = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry\s*>/gi)].map(
    (match) => {
      const title = match[1].match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
      return title ? decodeXml(title).trim() : "";
    },
  );
  if (titles.some((title) => safeTitle(title) === safeTitle(article.title))) {
    throw new Error("An article with this title already exists; refusing duplicate publish");
  }
  const categories = article.tags
    .map((tag) => '<category term="' + escapeXml(tag) + '" />')
    .join("");
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<entry xmlns="http://www.w3.org/2005/Atom">' +
    "<title>" +
    escapeXml(article.title) +
    '</title><content type="text/plain">' +
    escapeXml(article.body) +
    "</content>" +
    categories +
    "</entry>";
  const posted = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/atom+xml",
      Authorization: authorization,
      "Content-Type": "application/atom+xml; charset=utf-8",
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!posted.ok) throw new Error("Hatena publish failed: HTTP " + posted.status);
  return posted.headers.get("location");
}

async function main() {
  const date = getJstDate();
  const articlePath = path.join("articles", date + ".json");
  const statusPath = path.join("publishing-status", date + ".json");
  const latestPath = path.join("publishing-status", "latest.json");
  await fs.mkdir("articles", { recursive: true });
  await fs.mkdir("publishing-status", { recursive: true });

  let article;
  try {
    article = JSON.parse(await fs.readFile(articlePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    article = await generateArticle(date);
    await fs.writeFile(articlePath, JSON.stringify(article, null, 2) + "\n");
    commit([articlePath], "Save weekly PC support article " + date);
  }

  let previous;
  try {
    previous = JSON.parse(await fs.readFile(statusPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previous?.status === "published") {
    console.log("Already published: " + (previous.url || "URL unavailable"));
    return;
  }

  try {
    const url = await publish(article);
    const status = {
      date,
      status: "published",
      title: article.title,
      url,
      publishedAt: new Date().toISOString(),
      error: null,
    };
    await fs.writeFile(statusPath, JSON.stringify(status, null, 2) + "\n");
    await fs.writeFile(latestPath, JSON.stringify(status, null, 2) + "\n");
    commit([statusPath, latestPath], "Record Hatena publication " + date);
    console.log("Published " + date + ": " + (url || "URL unavailable"));
  } catch (error) {
    const status = {
      date,
      status: "failed",
      title: article.title,
      url: null,
      publishedAt: null,
      error: String(error.message || error).slice(0, 500),
    };
    await fs.writeFile(statusPath, JSON.stringify(status, null, 2) + "\n");
    await fs.writeFile(latestPath, JSON.stringify(status, null, 2) + "\n");
    commit([statusPath, latestPath], "Record Hatena publication failure " + date);
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
