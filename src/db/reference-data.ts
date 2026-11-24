export interface CountryRef {
  code: string;
  name: string;
  currency: string;
  usdRate: number;
}

export const COUNTRIES: readonly CountryRef[] = [
  { code: 'US', name: 'United States', currency: 'USD', usdRate: 1 },
  { code: 'IN', name: 'India', currency: 'INR', usdRate: 83.5 },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', usdRate: 0.79 },
  { code: 'DE', name: 'Germany', currency: 'EUR', usdRate: 0.92 },
  { code: 'CA', name: 'Canada', currency: 'CAD', usdRate: 1.37 },
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED', usdRate: 3.6725 },
  { code: 'SG', name: 'Singapore', currency: 'SGD', usdRate: 1.35 },
  { code: 'AU', name: 'Australia', currency: 'AUD', usdRate: 1.52 },
  { code: 'JP', name: 'Japan', currency: 'JPY', usdRate: 150 },
  { code: 'BR', name: 'Brazil', currency: 'BRL', usdRate: 5.0 },
];

export const LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5'] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_LABELS: Record<Level, string> = {
  L1: 'Associate',
  L2: 'Mid',
  L3: 'Senior',
  L4: 'Lead',
  L5: 'Principal',
};

export const DEPARTMENTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  Engineering: { 'Software Engineer': 95_000, 'QA Engineer': 75_000, 'DevOps Engineer': 95_000, 'Data Engineer': 95_000 },
  Product: { 'Product Manager': 100_000, 'Product Designer': 85_000 },
  Sales: { 'Account Executive': 65_000, 'Sales Development Rep': 50_000 },
  Marketing: { 'Marketing Specialist': 60_000, 'Content Strategist': 58_000 },
  'Customer Success': { 'Support Specialist': 45_000, 'Customer Success Manager': 60_000 },
  Finance: { 'Financial Analyst': 70_000, Accountant: 62_000 },
  'People & HR': { 'HR Generalist': 58_000, Recruiter: 60_000 },
  Operations: { 'Operations Analyst': 60_000, 'Office Manager': 50_000 },
};

export function currencyForCountry(code: string): string | undefined {
  return COUNTRIES.find((c) => c.code === code)?.currency;
}
