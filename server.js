// NutriMED 聯絡表單寄信後端
// 路由：POST /api/contact → 寄信到已驗證的 Gmail；其餘路徑 → 交給靜態網站
import { EmailMessage } from "cloudflare:email";
// 注意：Cloudflare Workers 必須用 mimetext 的「瀏覽器版」，預設 node 版會在執行階段出錯
import { createMimeMessage } from "mimetext/browser";

const FROM_ADDRESS = "info@nutrimed.com.tw"; // 寄件人（必須是 nutrimed.com.tw 網域）
const TO_ADDRESS = "roychen16888@gmail.com"; // 收件人（Email Routing 已驗證）

const POSITION_LABELS = {
  doctor: "執業中醫師",
  director: "院長／負責人",
  admin: "行政主管",
  staff: "診所行政人員",
  other: "其他",
};

const INTEREST_LABELS = {
  cooperation: "合作模式與商務條件",
  formula: "產品配方與機轉設計",
  plateau: "停滯期患者技術諮詢",
  trial: "實證觀察期合作流程",
  other: "其他",
};

// 個案技術諮詢：諮詢類型對照
const CONSULT_TYPE_LABELS = {
  general: "泛論性技術提問",
  case: "具體個案討論",
};

// 個案技術諮詢：個案五大類資訊的欄位標籤
const CASE_LABELS = [
  ["case1", "① 基本生理數據"],
  ["case2", "② 療程歷程"],
  ["case3", "③ 生活型態"],
  ["case4", "④ 中醫辨證"],
  ["case5", "⑤ 卡關線索"],
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "只接受 POST" }, 405);
      }
      // 防護網：任何未預期的錯誤都回傳可讀訊息，不會回非 JSON
      try {
        return await handleContact(request, env);
      } catch (err) {
        const detail = err && err.message ? err.message : String(err);
        console.error("contact handler error:", detail, err && err.stack);
        return json({ ok: false, error: "系統錯誤：" + detail }, 500);
      }
    }

    if (url.pathname === "/api/consultation") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "只接受 POST" }, 405);
      }
      // 防護網：任何未預期的錯誤都回傳可讀訊息，不會回非 JSON
      try {
        return await handleConsultation(request, env);
      } catch (err) {
        const detail = err && err.message ? err.message : String(err);
        console.error("consultation handler error:", detail, err && err.stack);
        return json({ ok: false, error: "系統錯誤：" + detail }, 500);
      }
    }

    // 其餘路徑一律交給靜態網站處理
    return env.ASSETS.fetch(request);
  },
};

async function handleContact(request, env) {
  // 1) 解析表單（同時支援 FormData 與 JSON）
  let data;
  try {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      data = await request.json();
    } else {
      data = formToObject(await request.formData());
    }
  } catch {
    return json({ ok: false, error: "無法解析表單資料" }, 400);
  }

  // 2) 後端驗證（不信任前端）
  const required = ["clinicName", "position", "contactName", "phone", "email"];
  for (const key of required) {
    if (!String(data[key] || "").trim()) {
      return json({ ok: false, error: "必填欄位未填寫完整" }, 400);
    }
  }
  const interests = toArray(data.interests);
  if (interests.length === 0) {
    return json({ ok: false, error: "請至少選擇一項想了解的事項" }, 400);
  }
  if (!isChecked(data.consent)) {
    return json({ ok: false, error: "請勾選同意條款" }, 400);
  }

  // 3) 組信件內容
  const positionLabel = POSITION_LABELS[data.position] || data.position;
  const interestText = interests.map((i) => INTEREST_LABELS[i] || i).join("、");

  const body = [
    "您收到一筆來自 nutrimed.com.tw 的醫療通路合作申請：",
    "",
    `診所名稱：${data.clinicName}`,
    `職稱：${positionLabel}`,
    `聯絡人：${data.contactName}`,
    `電話：${data.phone}`,
    `Email：${data.email}`,
    `LINE ID：${data.line ? data.line : "（未填）"}`,
    `想了解的事項：${interestText}`,
    "",
    "補充說明：",
    data.message ? data.message : "（未填）",
    "",
    "————————————————————",
    `送出時間：${taipeiNow()}（台北時間）`,
  ].join("\n");

  const subject = `【合作申請】${data.clinicName}　${data.contactName}`;

  // 4) 用 mimetext 組 MIME（自動處理中文編碼）
  const msg = createMimeMessage();
  msg.setSender({ name: "NutriMED 網站表單", addr: FROM_ADDRESS });
  msg.setRecipient(TO_ADDRESS);
  msg.setSubject(subject);
  // Reply-To 讓你可直接「回覆」給申請人；mimetext 視其為位址型標頭，須傳位址物件。
  // 包一層保險：萬一失敗就略過，不影響信件寄出。
  try {
    msg.setHeader("Reply-To", { addr: data.email });
  } catch (e) {
    console.warn("Reply-To skipped:", e && e.message ? e.message : e);
  }
  msg.addMessage({ contentType: "text/plain", data: body });

  const emailMessage = new EmailMessage(FROM_ADDRESS, TO_ADDRESS, msg.asRaw());

  // 5) 寄出
  try {
    await env.SEB.send(emailMessage);
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    console.error("send_email failed:", detail);
    return json({ ok: false, error: "寄信失敗：" + detail }, 502);
  }

  return json({ ok: true });
}

// ===== 個案技術諮詢處理 =====
async function handleConsultation(request, env) {
  // 1) 解析表單（同時支援 FormData 與 JSON）
  let data;
  try {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      data = await request.json();
    } else {
      data = formToObject(await request.formData());
    }
  } catch {
    return json({ ok: false, error: "無法解析表單資料" }, 400);
  }

  // 2) 後端驗證（不信任前端；規則對齊前端問卷）
  const docName = String(data.docName || "").trim();
  const clinicName = String(data.clinicName || "").trim();
  const mainQuestion = String(data.mainQuestion || "").trim();
  const docEmail = String(data.docEmail || "").trim();
  const docLine = String(data.docLine || "").trim();

  if (!docName) return json({ ok: false, error: "請填寫您的稱呼" }, 400);
  if (!clinicName) return json({ ok: false, error: "請填寫診所名稱" }, 400);
  if (!mainQuestion) return json({ ok: false, error: "請填寫主要諮詢問題" }, 400);
  if (!docEmail && !docLine) {
    return json({ ok: false, error: "請至少填寫一項聯絡方式（E-mail 或 LINE ID）" }, 400);
  }
  if (!isChecked(data.consent)) {
    return json({ ok: false, error: "請勾選同意聲明" }, 400);
  }

  // 3) 組信件內容
  const consultType = String(data.consultType || "general");
  const consultTypeLabel = CONSULT_TYPE_LABELS[consultType] || consultType;

  const lines = [
    "您收到一筆來自 nutrimed.com.tw 的個案技術諮詢：",
    "",
    `諮詢類型：${consultTypeLabel}`,
    "",
    "◆ 聯絡資訊",
    `稱呼：${docName}`,
    `診所：${clinicName}`,
    `E-mail：${docEmail ? docEmail : "（未填）"}`,
    `LINE ID：${docLine ? docLine : "（未填）"}`,
    "",
    "◆ 主要諮詢問題",
    mainQuestion,
  ];

  // 個案五大類資訊：僅「具體個案討論」且有填內容時才附上
  if (consultType === "case") {
    const filled = [];
    for (const [key, label] of CASE_LABELS) {
      const val = String(data[key] || "").trim();
      if (val) filled.push(`${label}：\n${val}`);
    }
    if (filled.length > 0) {
      lines.push("", "◆ 個案五大類資訊（已匿名化）", filled.join("\n\n"));
    }
  }

  const additional = String(data.additional || "").trim();
  if (additional) {
    lines.push("", "◆ 補充說明", additional);
  }

  lines.push(
    "",
    "————————————————————",
    `送出時間：${taipeiNow()}（台北時間）`
  );

  const body = lines.join("\n");
  const subject = `【個案技術諮詢】${clinicName}　${docName}`;

  // 4) 用 mimetext 組 MIME（自動處理中文編碼）
  const msg = createMimeMessage();
  msg.setSender({ name: "NutriMED 個案諮詢", addr: FROM_ADDRESS });
  msg.setRecipient(TO_ADDRESS);
  msg.setSubject(subject);
  // Reply-To 讓你可直接「回覆」給諮詢醫師（若有填 E-mail）
  if (docEmail) {
    try {
      msg.setHeader("Reply-To", { addr: docEmail });
    } catch (e) {
      console.warn("Reply-To skipped:", e && e.message ? e.message : e);
    }
  }
  msg.addMessage({ contentType: "text/plain", data: body });

  const emailMessage = new EmailMessage(FROM_ADDRESS, TO_ADDRESS, msg.asRaw());

  // 5) 寄出
  try {
    await env.SEB.send(emailMessage);
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    console.error("send_email failed:", detail);
    return json({ ok: false, error: "寄信失敗：" + detail }, 502);
  }

  return json({ ok: true });
}

// ---------- 小工具 ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function formToObject(form) {
  const obj = {};
  for (const key of form.keys()) {
    const values = form.getAll(key);
    obj[key] = values.length > 1 ? values : values[0];
  }
  return obj;
}

function toArray(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => String(x || "").trim());
}

function isChecked(v) {
  return v === true || ["on", "true", "1", "yes"].includes(String(v).toLowerCase());
}

// 不依賴系統時區資料，直接以 UTC+8 計算台北時間
function taipeiNow() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
