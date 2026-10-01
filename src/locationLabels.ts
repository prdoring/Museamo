export interface LocationLabelParts {
  name?: string;
  address?: string;
  locality?: string;
  userLabel?: string;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
}

const states: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS",
  Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA",
  Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT",
  Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
  Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT",
  Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV",
  Wisconsin: "WI", Wyoming: "WY", "District of Columbia": "DC",
};
const clean = (value?: string) => value?.replace(/\s+/g, " ").trim() || "";
const normalized = (value: string) => value.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
const stateCode = (value: string) => Object.entries(states).find(([name, code]) => normalized(value) === normalized(name) || value.toUpperCase() === code)?.[1];

export function locationLabel(location: LocationLabelParts): string {
  const locality = clean(location.locality), parts = locality.split(",").map(p => p.trim());
  const city = clean(location.city) || parts[0];
  const region = clean(location.region) || (parts.length > 1 ? parts.at(-1)! : "");
  const code = clean(location.countryCode).toUpperCase();
  let country = clean(location.country);
  if (/^[A-Z]{2}$/.test(code)) {
    try { country = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(code) || country; }
    catch {}
  }
  const us = code === "US" || (!code && ["us", "usa", "united states", "united states of america"].includes(normalized(country))) || (!code && !country && !!stateCode(region));
  const area = us
    ? [city, stateCode(region) || region].filter(Boolean).join(" ") || country
    : country ? [...new Set([city, country].filter(Boolean))].join(", ")
    : locality || [city, region].filter(Boolean).join(", ");
  const custom = clean(location.userLabel), detected = clean(location.name);
  const name = custom || (detected && normalized(detected) !== normalized(clean(location.address)) ? detected : "");
  if (!name) return area || "Saved location";
  if (!area || normalized(name) === normalized(area)) return name;
  if ([city, region, country].some(value => value && normalized(value) === normalized(name))) return area;
  if (normalized(name).endsWith(" " + normalized(area))) return name;
  return `${name}, ${area}`;
}
