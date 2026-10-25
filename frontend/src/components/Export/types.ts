export interface SorobanType {
  kind: string;
  elements?: SorobanType[];
  child?: SorobanType;
  defName?: string;
}
export interface SpecField {
  name: string;
  type: SorobanType;
}
export interface ContractSpec {
  name: string;
  version?: string;
  description?: string;
  functions: {
    name: string;
    doc?: string;
    inputs: SpecField[];
    outputs: SorobanType[];
    read_only?: boolean;
  }[];
  structs?: { name: string; doc?: string; fields: SpecField[] }[];
  enums?: { name: string; cases: { name: string; value: number }[] }[];
  errors?: { name: string; code: number; doc?: string }[];
  events?: { name: string; fields: SpecField[] }[];
}
export interface SdkBundle {
  name: string;
  files: { name: string; content: string }[];
}
