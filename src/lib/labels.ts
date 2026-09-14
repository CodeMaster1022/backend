export const PERIL_LABEL: Record<string, string> = {
  FL_HURRICANE: "Florida hurricane",
  FL_FLOOD: "Florida flood",
  CA_WILDFIRE: "California wildfire",
  CA_EARTHQUAKE: "California earthquake",
};

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  ELIGIBILITY_FAILED: "Eligibility failed",
  AWAITING_QUOTE: "Awaiting quote",
  QUOTED: "Quoted",
  AWAITING_OWNER_FUNDS: "Awaiting owner 15%",
  LIVE: "Live",
  FULLY_FUNDED: "Fully funded",
  AWAITING_LENDER: "Awaiting lender",
  BINDING: "Binding",
  ACTIVE: "Active policy",
  EXPIRED: "Expired",
  TOPUP_WINDOW: "Top-up window",
  TOPUP_LAPSED: "Top-up lapsed",
  DECLINED: "Declined",
  ARCHIVED: "Archived",
};

export function radiusKmForPeril(peril: string) {
  switch (peril) {
    case "FL_HURRICANE":
      return 50;
    case "FL_FLOOD":
      return 15;
    case "CA_WILDFIRE":
      return 10;
    case "CA_EARTHQUAKE":
      return 40;
    default:
      return 25;
  }
}
