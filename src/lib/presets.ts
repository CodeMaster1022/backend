import type { StateCode } from "@prisma/client";

export const PRESETS: Record<
  string,
  { lat: number; lng: number; city: string; county: string; state: StateCode; zip: string }
> = {
  fort_myers: {
    lat: 26.6406,
    lng: -81.8723,
    city: "Fort Myers",
    county: "Lee",
    state: "FL",
    zip: "33901",
  },
  miami: {
    lat: 25.7617,
    lng: -80.1918,
    city: "Miami",
    county: "Miami-Dade",
    state: "FL",
    zip: "33101",
  },
  sacramento: {
    lat: 38.5816,
    lng: -121.4944,
    city: "Sacramento",
    county: "Sacramento",
    state: "CA",
    zip: "95814",
  },
  los_angeles: {
    lat: 34.0522,
    lng: -118.2437,
    city: "Los Angeles",
    county: "Los Angeles",
    state: "CA",
    zip: "90012",
  },
};
