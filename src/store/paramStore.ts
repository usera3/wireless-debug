import { create } from 'zustand';

export interface ParamDef {
  id: string;        // "001-003"
  regAddr: number;   // Modbus 寄存器地址（PPP*256+NNN）
  alias: string;
  name: string;
  unit: string;
  desc: string;
  decimals: number;
  signed: boolean;
  isFloat: boolean;  // float 类型需读 2 个寄存器
  readOnly: boolean;
  hidden: boolean;
  max: number;
  min: number;
  defaultVal: number;
  page: string;      // sheet name
}

interface ParamState {
  pages: string[];
  params: ParamDef[];
  values: Record<string, number>; // alias -> 已解析值（实际值）
  activePage: string;
  search: string;
  loadParams: (params: ParamDef[], pages: string[]) => void;
  setValue: (alias: string, val: number) => void;
  setActivePage: (page: string) => void;
  setSearch: (s: string) => void;
}

export const useParamStore = create<ParamState>((set) => ({
  pages: [],
  params: [],
  values: {},
  activePage: '',
  search: '',
  loadParams: (params, pages) => set({ params, pages }),
  setValue: (alias, val) =>
    set((s) => ({ values: { ...s.values, [alias]: val } })),
  setActivePage: (page) => set({ activePage: page }),
  setSearch: (s) => set({ search: s }),
}));
