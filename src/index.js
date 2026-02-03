/**
 * Cloudflare Worker — бэкенд Lookmax (D1).
 * Привязка: env.DB (D1).
 */

const AUTH_KEY = "ZarechyeMax2024";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain", ...CORS },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (request.method === "GET") {
      return handleGet(env);
    }

    if (request.method === "POST") {
      let data;
      try {
        data = await request.json();
      } catch (e) {
        return text("Invalid JSON", 400);
      }
      return handlePost(data, env);
    }

    return text("Method not allowed", 405);
  },
};

async function handleGet(env) {
  const db = env.DB;
  if (!db) return json({ error: "DB not configured" }, 500);

  try {
    const [candidatesRows, votesRows, commentsRows, usersRows] = await Promise.all([
      db.prepare(
        "SELECT id, name, photo, description, tg, approved, music FROM candidates WHERE approved = 'ДА'"
      ).all(),
      db.prepare("SELECT candidate_id, score, date, email FROM votes ORDER BY id").all(),
      db.prepare("SELECT candidate_id, author, text, date, email FROM comments ORDER BY id").all(),
      db.prepare("SELECT email, nickname FROM users").all(),
    ]);

    const usersMap = {};
    for (const row of usersRows.results || []) {
      usersMap[row.email] = row.nickname;
    }

    const candidates = (candidatesRows.results || []).map((r) => ({
      id: r.id,
      name: r.name,
      photo: r.photo || "",
      description: r.description || "",
      tg: r.tg || "",
      music: r.music || "",
    }));

    const votes = (votesRows.results || []).map((r) => [
      r.candidate_id,
      r.score,
      r.date,
      r.email,
    ]);

    const comments = (commentsRows.results || []).map((r) => {
      const nick = usersMap[r.email] || r.author;
      return [r.candidate_id, nick, r.text, r.date, r.email];
    });

    return json({ candidates, votes, comments });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

async function handlePost(data, env) {
  const db = env.DB;
  if (!db) return text("DB not configured", 500);

  const type = data.type;

  if (type === "vote") {
    const email = data.userEmail || "Гость";
    const targetId = data.targetId;
    const rating = Number(data.rating);
    if (!targetId || !Number.isFinite(rating)) return text("Bad request", 400);

    try {
      const existing = await db
        .prepare("SELECT id FROM votes WHERE candidate_id = ? AND email = ?")
        .bind(targetId, email)
        .first();

      const now = new Date().toISOString();

      if (existing) {
        await db
          .prepare("UPDATE votes SET score = ?, date = ? WHERE id = ?")
          .bind(rating, now, existing.id)
          .run();
        return text("Vote updated");
      }

      await db
        .prepare("INSERT INTO votes (candidate_id, score, date, email) VALUES (?, ?, ?, ?)")
        .bind(targetId, rating, now, email)
        .run();
      return text("Vote saved");
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }

  if (type === "comment") {
    const email = data.userEmail || "Гость";
    const targetId = data.targetId;
    const text_ = data.text;
    const userName = data.userName || "Гость";
    if (!targetId || !text_) return text("Bad request", 400);

    try {
      const lastComment = await db
        .prepare("SELECT date FROM comments WHERE email = ? ORDER BY id DESC LIMIT 1")
        .bind(email)
        .first();

      if (lastComment) {
        const last = new Date(lastComment.date).getTime();
        if (Date.now() - last < 5000) return text("Wait before commenting", 429);
      }

      const now = new Date().toISOString();
      await db
        .prepare(
          "INSERT INTO comments (candidate_id, text, author, date, email) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(targetId, text_, userName, now, email)
        .run();
      return text("Comment saved");
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }

  if (type === "add_candidate") {
    if (data.auth !== AUTH_KEY) return text("Forbidden: Wrong Auth Key", 403);

    const id = data.id;
    const name = data.name;
    const photo = data.photo || "";
    const description = data.description || "";
    const tg = data.tg || "";
    const music = data.music || "";
    if (!id || !name) return text("Bad request", 400);

    try {
      await db
        .prepare(
          `INSERT INTO candidates (id, name, photo, description, tg, approved, music)
           VALUES (?, ?, ?, ?, ?, 'НЕТ', ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             photo = excluded.photo,
             description = excluded.description,
             tg = excluded.tg,
             music = excluded.music,
             approved = 'НЕТ'`
        )
        .bind(id, name, photo, description, tg, music)
        .run();
      return text("Success");
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }

  if (type === "admin_boost") {
    if (data.auth !== AUTH_KEY) return text("Forbidden: Wrong Auth Key", 403);

    const targetId = data.targetId;
    let count = parseInt(data.count, 10) || 0;
    if (!targetId || count <= 0) return text("Invalid parameters", 400);

    try {
      const now = new Date().toISOString();
      const n = parseInt(data.count, 10) || 0;
      for (let i = 0; i < n; i++) {
        await db
          .prepare("INSERT INTO votes (candidate_id, score, date, email) VALUES (?, 5, ?, 'Admin')")
          .bind(targetId, now)
          .run();
      }
      return text("Boost applied: " + n + " votes");
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }

  if (type === "user" || type === "user_register") {
    const email = data.userEmail || data.email || "";
    const nickname = data.nickname || data.userName || "";
    if (!email || !nickname) return text("Missing email or nickname", 400);

    try {
      const existing = await db.prepare("SELECT email FROM users WHERE email = ?").bind(email).first();
      if (existing) {
        await db.prepare("UPDATE users SET nickname = ? WHERE email = ?").bind(nickname, email).run();
        return text("User updated");
      }
      await db.prepare("INSERT INTO users (email, nickname) VALUES (?, ?)").bind(email, nickname).run();
      return text("User saved");
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }

  return text("Unknown type", 400);
}
