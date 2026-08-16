/**
 * Shared domain types.
 *
 * Nothing in here is allowed to reference Trip.com response shapes directly —
 * the raw payload only exists inside `src/extract/`, which is the single place
 * that has to change when Trip.com changes its API.
 */

/** A market is one Trip.com storefront (host + locale + region + currency). */
export type MarketCode = string;

export interface MarketConfig {
  /** Two letter market code, e.g. "JP", "NL". */
  code: MarketCode;
  /** Full origin of the storefront, e.g. "https://jp.trip.com". */
  origin: string;
  /** `head.locale` value used by the storefront, e.g. "ja-JP". */
  locale: string;
  /** `head.region` value used by the storefront, e.g. "JP". */
  region: string;
  /** Storefront default currency. Overridden by the requested display currency. */
  defaultCurrency: string;
  /** `Accept-Language` / browser language for this market. */
  acceptLanguage: string;
  /**
   * Optional proxy for IP-geolocation testing (MVP step 10).
   * Format understood by Playwright: `http://user:pass@host:port`.
   */
  proxy?: string;
}

/** Search conditions extracted from a Trip.com URL. */
export interface SearchCriteria {
  hotelId: number;
  /** ISO date `YYYY-MM-DD`. */
  checkIn: string;
  /** ISO date `YYYY-MM-DD`. */
  checkOut: string;
  adult: number;
  children: number;
  /** Ages of each child, when the URL carries them. */
  childAges: number[];
  roomQuantity: number;
  /** Currency the comparison is displayed in, e.g. "JPY". */
  currency: string;
  /** Room preselected in the source URL, if any. */
  roomId?: number;
}

/** Cancellation policy, normalized away from market-specific wording. */
export type CancellationKind = 'free' | 'non-refundable' | 'conditional' | 'unknown';

/** Meal plan, normalized away from market-specific wording. */
export type MealKind = 'room-only' | 'breakfast' | 'half-board' | 'full-board' | 'all-inclusive' | 'unknown';

/** Pay now vs pay at the property. */
export type PaymentKind = 'prepay' | 'pay-at-hotel' | 'unknown';

/**
 * One sellable offer (a room + rate plan) as returned by one market.
 * Prices are for the whole stay and the requested room quantity, in `currency`.
 */
export interface RoomOffer {
  hotelId: number;
  /** Stable physical room identity. Primary matching key. */
  physicalRoomId: number | null;
  /** Rate-plan level room identity. */
  roomId: number | null;
  /** Human-opaque plan code, e.g. "Q72FXT-Z-1". */
  roomCode: string | null;
  /** Localized name. Display only — never used for matching. */
  roomName: string | null;
  availability: boolean;
  remainRoomQuantity: number | null;
  currency: string;
  /** Base price before tax/fees, if the market exposes it. */
  price: number | null;
  tax: number | null;
  /** Price actually charged, tax inclusive. This is what gets compared. */
  totalPrice: number | null;
  /** Strike-through / pre-discount price, if any. */
  originalPrice: number | null;
  meal: MealKind;
  mealRaw: string | null;
  cancellation: CancellationKind;
  cancellationRaw: string | null;
  payment: PaymentKind;
  /** Whether `totalPrice` already includes taxes and service fees. */
  taxIncluded: boolean;
}

/** Result of scraping one market once. */
export interface MarketSample {
  market: MarketCode;
  /** ISO timestamp of when the response was captured. */
  capturedAt: string;
  offers: RoomOffer[];
}

/** A market that could not be sampled. */
export interface MarketFailure {
  market: MarketCode;
  /** Machine readable reason, e.g. "http-430", "captcha", "timeout". */
  reason: string;
  message: string;
  /** True when a human has to intervene (CAPTCHA, login, blocked). */
  manualActionRequired: boolean;
}

/** One market's entry in the final comparison, after matching and FX. */
export interface MarketPrice {
  market: MarketCode;
  physicalRoomId: number | null;
  roomId: number | null;
  roomCode: string | null;
  roomName: string | null;
  currency: string;
  /** Price in the market's own currency. */
  originalPrice: number;
  /** Price converted to the target currency. */
  jpyPrice: number;
  /** Target-currency price, named generically. Same value as `jpyPrice`. */
  convertedPrice: number;
  targetCurrency: string;
  availability: boolean;
  meal: MealKind;
  cancellation: CancellationKind;
  payment: PaymentKind;
  taxIncluded: boolean;
  /** Number of samples taken; `convertedPrice` is their median. */
  sampleCount: number;
  /** ISO timestamps of every sample that fed this price. */
  capturedAt: string[];
}

export interface ComparisonResult {
  hotel: {
    hotelId: number;
    name: string | null;
    checkIn: string;
    checkOut: string;
    adult: number;
    children: number;
    roomQuantity: number;
  };
  /** The offer identity every listed market agreed on. */
  matchedOn: {
    physicalRoomId: number | null;
    roomId: number | null;
    roomCode: string | null;
    meal: MealKind;
    cancellation: CancellationKind;
    payment: PaymentKind;
    taxIncluded: boolean;
  } | null;
  prices: MarketPrice[];
  cheapestMarket: MarketCode | null;
  /** How much cheaper the cheapest market is than JP, in target currency. */
  savingVsJapan: number | null;
  targetCurrency: string;
  /** Markets that were requested but produced no comparable offer. */
  failures: MarketFailure[];
  /** Markets that responded but had no offer matching the others. */
  unmatchedMarkets: MarketCode[];
}
