/**
 * AWS実務クイズ API サーバー
 * EC2上で稼働し、RDS(MySQL)から問題・カテゴリデータを取得するREST APIを提供します。
 *
 * エンドポイント:
 *   GET  /api/categories          -> カテゴリ一覧
 *   GET  /api/questions           -> 全問題一覧（?categories=IAM,EC2 で絞り込み）
 *   GET  /api/questions/:id       -> 単一問題
 *   POST /api/questions           -> 問題追加（管理用）
 *   PUT  /api/questions/:id       -> 問題更新（管理用）
 *   DELETE /api/questions/:id     -> 問題削除（管理用）
 */

require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ---- RDS接続プール ----
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// 起動時に接続確認
(async () => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    console.log('[OK] RDSへの接続に成功しました');
  } catch (err) {
    console.error('[NG] RDSへの接続に失敗しました:', err.message);
  }
})();

// ---- ヘルスチェック ----
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ---- カテゴリ一覧 ----
app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT code, name, color, description FROM categories ORDER BY code'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'カテゴリ取得に失敗しました' });
  }
});

// ---- 問題一覧（カテゴリ絞り込み対応） ----
app.get('/api/questions', async (req, res) => {
  try {
    let sql = `
      SELECT id, category_code AS cat, question_text AS q,
             choice_1, choice_2, choice_3, choice_4,
             correct_index, explanation AS exp, practical_tip AS tip
      FROM questions
    `;
    const params = [];

    if (req.query.categories) {
      const cats = req.query.categories.split(',').map(c => c.trim()).filter(Boolean);
      if (cats.length > 0) {
        sql += ` WHERE category_code IN (${cats.map(() => '?').join(',')})`;
        params.push(...cats);
      }
    }

    const [rows] = await pool.query(sql, params);

    // choice_1..4 を choices 配列にまとめてフロント用の形に整形
    const questions = rows.map(r => ({
      id: r.id,
      cat: r.cat,
      q: r.q,
      choices: [r.choice_1, r.choice_2, r.choice_3, r.choice_4],
      correct: r.correct_index,
      exp: r.exp,
      tip: r.tip,
    }));

    res.json(questions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '問題取得に失敗しました' });
  }
});

// ---- 単一問題取得 ----
app.get('/api/questions/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, category_code AS cat, question_text AS q,
              choice_1, choice_2, choice_3, choice_4,
              correct_index, explanation AS exp, practical_tip AS tip
       FROM questions WHERE id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '問題が見つかりません' });
    const r = rows[0];
    res.json({
      id: r.id,
      cat: r.cat,
      q: r.q,
      choices: [r.choice_1, r.choice_2, r.choice_3, r.choice_4],
      correct: r.correct_index,
      exp: r.exp,
      tip: r.tip,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '問題取得に失敗しました' });
  }
});

// ---- 問題追加（管理用） ----
app.post('/api/questions', async (req, res) => {
  try {
    const { cat, q, choices, correct, exp, tip } = req.body;
    if (!cat || !q || !Array.isArray(choices) || choices.length !== 4 ||
        typeof correct !== 'number' || !exp || !tip) {
      return res.status(400).json({ error: '必須フィールドが不足しています' });
    }
    const [result] = await pool.query(
      `INSERT INTO questions
        (category_code, question_text, choice_1, choice_2, choice_3, choice_4, correct_index, explanation, practical_tip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cat, q, choices[0], choices[1], choices[2], choices[3], correct, exp, tip]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '問題追加に失敗しました' });
  }
});

// ---- 問題更新（管理用） ----
app.put('/api/questions/:id', async (req, res) => {
  try {
    const { cat, q, choices, correct, exp, tip } = req.body;
    if (!cat || !q || !Array.isArray(choices) || choices.length !== 4 ||
        typeof correct !== 'number' || !exp || !tip) {
      return res.status(400).json({ error: '必須フィールドが不足しています' });
    }
    await pool.query(
      `UPDATE questions SET
        category_code=?, question_text=?, choice_1=?, choice_2=?, choice_3=?, choice_4=?,
        correct_index=?, explanation=?, practical_tip=?
       WHERE id=?`,
      [cat, q, choices[0], choices[1], choices[2], choices[3], correct, exp, tip, req.params.id]
    );
    res.json({ status: 'updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '問題更新に失敗しました' });
  }
});

// ---- 問題削除（管理用） ----
app.delete('/api/questions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM questions WHERE id = ?', [req.params.id]);
    res.json({ status: 'deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '問題削除に失敗しました' });
  }
});

// ---- 静的ファイル配信（フロントのHTMLをそのまま返す場合） ----
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AWS実務クイズ API サーバーが起動しました: http://localhost:${PORT}`);
});