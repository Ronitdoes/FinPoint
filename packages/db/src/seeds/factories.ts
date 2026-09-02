/**
 * Deterministic Pseudo-Random Generator and Test Data Factories
 * Uses Mulberry32 PRNG with fixed seed (0x4D2FB5A1) ensuring CI golden tests
 * produce identical content hashes on reseeding (Spec 01 §24, Spec 03 §3).
 */

export const DEFAULT_SEED = 0x4d2fb5a1;
export const REFERENCE_DATE = new Date("2026-09-01T00:00:00.000Z");

export class DeterministicPrng {
  private state: number;

  constructor(seed: number = DEFAULT_SEED) {
    this.state = seed;
  }

  /**
   * Returns a pseudo-random float in [0, 1).
   */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Returns integer in range [min, max] inclusive.
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Picks a random element from an array.
   */
  choice<T>(items: readonly T[]): T {
    return items[this.nextInt(0, items.length - 1)]!;
  }

  /**
   * Generates a log-normal financial amount in minor units (paise / cents).
   * Produces realistic ecommerce/SaaS ticket sizes with long right-tail up to enterprise scale.
   */
  logNormalAmount(medianMinor: number = 250000, sigma: number = 0.85): bigint {
    const u1 = Math.max(1e-7, this.next());
    const u2 = this.next();
    const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    const amount = Math.round(medianMinor * Math.exp(z * sigma));
    // Clamp between ₹99 (9900 paise) and ₹5,00,000 (50000000 paise)
    return BigInt(Math.max(9900, Math.min(amount, 50000000)));
  }

  /**
   * Generates a date spread uniformly between [daysAgoMin, daysAgoMax].
   */
  dateSpread(
    daysAgoMin: number,
    daysAgoMax: number,
    refDate: Date = REFERENCE_DATE,
  ): Date {
    const daysAgo = daysAgoMin + (daysAgoMax - daysAgoMin) * this.next();
    const secondsOffset = this.nextInt(0, 86399);
    return new Date(refDate.getTime() - (daysAgo * 86400 + secondsOffset) * 1000);
  }

  /**
   * Generates a deterministic UUID based on seed state.
   */
  uuid(): string {
    const hex = (len: number) => {
      let str = "";
      for (let i = 0; i < len; i++) {
        str += this.nextInt(0, 15).toString(16);
      }
      return str;
    };
    return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
  }
}

export const FIRST_NAMES = [
  "Aarav", "Aditi", "Rohan", "Priya", "Vikram", "Sneha", "Karan", "Ananya",
  "Kabir", "Neha", "Arjun", "Pooja", "Rahul", "Divya", "Siddharth", "Rhea",
  "Dev", "Ishaan", "Tanvi", "Amit", "Meera", "Varun", "Sunita", "Rajesh",
  "Alok", "Shreya", "Nikhil", "Tarun", "Kavita", "Suresh", "Manish", "Preeti",
  "Deepak", "Anjali", "Sanjay", "Komal", "Gaurav", "Simran", "Harsh", "Vidya",
] as const;

export const LAST_NAMES = [
  "Sharma", "Verma", "Patel", "Mehta", "Iyer", "Nair", "Reddy", "Chopra",
  "Gupta", "Malhotra", "Kapoor", "Bhatia", "Joshi", "Saxena", "Deshmukh",
  "Kulkarni", "Singhania", "Mukherjee", "Banerjee", "Bose", "Menon", "Pillai",
  "Agarwal", "Mishra", "Pandey", "Trivedi", "Dubey", "Yadav", "Rao", "Hegde",
] as const;

export const DOMAINS = [
  "gmail.com", "outlook.com", "yahoo.com", "enterprise.in", "techcorp.io",
  "startup.co", "solutions.com", "global.net", "consulting.org",
] as const;

export const DECLINE_CODES = [
  "insufficient_funds",
  "card_declined",
  "expired_card",
  "do_not_honor",
  "transaction_not_allowed",
  "processing_error",
  "suspected_fraud",
  "withdrawal_count_limit_exceeded",
] as const;

export const CARD_BRANDS = ["visa", "mastercard", "rupay", "amex"] as const;

export const CHANNELS = ["WHATSAPP", "EMAIL"] as const;

export const RISK_BANDS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export const CASE_STATUSES = [
  "DETECTED", "QUALIFIED", "IN_PROGRESS", "RECOVERED", "STOPPED", "ESCALATED",
] as const;
