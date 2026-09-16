import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
const resend = apiKey ? new Resend(apiKey) : null;
const FROM = process.env.RESEND_FROM_EMAIL ?? "FiSure <onboarding@resend.dev>";

/**
 * Best-effort — never throws. Notification delivery is not allowed to break
 * the business operation it's reporting on (a refund, a bind, a claim), so
 * failures are logged, not propagated.
 */
export async function sendEmail(params: { to: string; subject: string; text: string }) {
  if (!resend) {
    console.log(`[email skipped — RESEND_API_KEY not set] to=${params.to} subject="${params.subject}"`);
    return;
  }
  try {
    const result = await resend.emails.send({
      from: FROM,
      to: params.to,
      subject: params.subject,
      text: params.text,
    });
    if (result.error) {
      console.error("Resend rejected email:", result.error);
    }
  } catch (err) {
    console.error("Email send failed:", err instanceof Error ? err.message : err);
  }
}
