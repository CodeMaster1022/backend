import { runTriggerPoll } from "../routes/triggers.js";
import { expireOrTopUpListings } from "../routes/listings.js";

const TRIGGER_POLL_MS = Number(process.env.TRIGGER_POLL_INTERVAL_MS ?? 5 * 60 * 1000);
const LISTING_SWEEP_MS = Number(process.env.LISTING_SWEEP_INTERVAL_MS ?? 60 * 60 * 1000);

export function startSchedulers() {
  setInterval(() => {
    runTriggerPoll().catch((error) => console.error("Scheduled trigger poll failed", error));
  }, TRIGGER_POLL_MS);

  setInterval(() => {
    expireOrTopUpListings().catch((error) => console.error("Scheduled listing sweep failed", error));
  }, LISTING_SWEEP_MS);

  console.log(
    `Schedulers running: trigger poll every ${Math.round(TRIGGER_POLL_MS / 1000)}s, listing sweep every ${Math.round(LISTING_SWEEP_MS / 1000)}s`,
  );
}
