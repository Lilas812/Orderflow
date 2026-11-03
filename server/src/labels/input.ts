export interface LabelHourInput {
  hour: number;
  book?: string;
  tick?: string;
  bookCoverage: [number, number][];
  tickCoverage: [number, number][];
}
export type LabelInputProvider = (hour: number, directory: string) => Promise<LabelHourInput>;
