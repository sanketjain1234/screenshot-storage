import { ColumnEntry, CustomColumnDef } from '../columns/column-registry';

export interface ColumnConfig {
  id: string;
  name: string;
  columns: ColumnEntry[];
  customColumns?: CustomColumnDef[];
  createdAt: Date;
}
