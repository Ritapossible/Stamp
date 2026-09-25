/**
 * Company-name → US ticker. Deliberately small and explicit: a name that is not here must be
 * typed as a ticker or symbol. Never fuzzy-match a stock name.
 */
export const NAME_TO_TICKER: Readonly<Record<string, string>> = {
  NVIDIA: "NVDA",
  NETFLIX: "NFLX",
  APPLE: "AAPL",
  TESLA: "TSLA",
  MICROSOFT: "MSFT",
  GOOGLE: "GOOGL",
  ALPHABET: "GOOGL",
  AMAZON: "AMZN",
  META: "META",
  FACEBOOK: "META",
  MICRON: "MU",
  BROADCOM: "AVGO",
  "KLA": "KLAC",
  CROWDSTRIKE: "CRWD",
  SERVICENOW: "NOW",
  CARVANA: "CVNA",
  ORACLE: "ORCL",
  AMD: "AMD",
  COINBASE: "COIN",
  PALANTIR: "PLTR",
};
