// NutriMED 聯絡表單寄信後端
// 路由：POST /api/contact → 寄信到已驗證的 Gmail；其餘路徑 → 交給靜態網站
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "只接受 POST" }, 405);
      }
      return handleContact(request, env);
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
  const submittedAt = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

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
    `送出時間：${submittedAt}（台北時間）`,
  ].join("\n");

  const subject = `【合作申請】${data.clinicName}　${data.contactName}`;

  // 4) 用 mimetext 組 MIME（自動處理中文編碼）
  const msg = createMimeMessage();
  msg.setSender({ name: "NutriMED 網站表單", addr: FROM_ADDRESS });
  msg.setRecipient(TO_ADDRESS);
  msg.setSubject(subject);
  msg.setHeader("Reply-To", data.email); // 讓你可直接「回覆」給申請人
  msg.addMessage({ contentType: "text/plain", data: body });

  const emailMessage = new EmailMessage(FROM_ADDRESS, TO_ADDRESS, msg.asRaw());

  // 5) 寄出
  try {
    await env.SEB.send(emailMessage);
  } catch (err) {
    console.error("send_email failed:", err && err.message ? err.message : err);
    return json({ ok: false, error: "寄信失敗，請改用 LINE 或 Email 與我們聯繫" }, 502);
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
