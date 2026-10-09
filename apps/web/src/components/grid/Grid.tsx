"use client";

import { useEffect, useMemo, useState } from "react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GetRowIdFunc, type GridApi, type GridReadyEvent } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import "@/styles/grid.css";

ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid v36 Theming API: Quartz as the base, then Patrick's tokens on top
// (white paper, black ink, heavy borders, Space Grotesk headers, mono numbers).
export const recourseTheme = themeQuartz.withParams({
  accentColor: "#000000",
  backgroundColor: "#ffffff",
  foregroundColor: "#000000",
  borderColor: "#000000",
  browserColorScheme: "light",
  fontFamily: "var(--f-body)",
  fontSize: 14,
  headerFontFamily: "var(--f-body)",
  headerFontSize: 11,
  headerFontWeight: 600,
  headerBackgroundColor: "#f5f1e8",
  headerTextColor: "#000000",
  oddRowBackgroundColor: "#fffefb",
  rowHoverColor: "#f7efce",
  selectedRowBackgroundColor: "#f0dfa0",
  wrapperBorder: { width: 2, color: "#000000", style: "solid" },
  wrapperBorderRadius: 8,
  rowBorder: { width: 1, color: "#d9d2c3", style: "dashed" },
  columnBorder: false,
  headerRowBorder: { width: 2, color: "#000000", style: "solid" },
  headerColumnBorder: false,
  headerColumnResizeHandleColor: "#bdb5a6",
  headerColumnResizeHandleHeight: "40%",
  headerColumnResizeHandleWidth: 1,
  pinnedRowBorder: { width: 2, color: "#000000", style: "solid" },
  pinnedColumnBorder: { width: 2, color: "#000000", style: "solid" },
  pinnedRowBackgroundColor: "#ede5d8",
  pinnedRowFontWeight: 600,
  cellHorizontalPaddingScale: 0.9,
  rowHeight: 48,
  headerHeight: 42,
  spacing: 7,
  inputBorder: { width: 1, color: "#6b6b6b", style: "solid" },
  inputBackgroundColor: "#ffffff",
  inputFocusBorder: { width: 2, color: "#000000", style: "solid" },
  inputFocusShadow: { spread: 4, color: "#f0dfa0" },
  focusShadow: { spread: 3, color: "#f0dfa0" },
  inputHeight: 30,
});

export const ROW_H = 48;
export const HEADER_H = 42;
export const FLOAT_H = 38;

interface Props<T> {
  rows: T[] | null;
  columns: ColDef<T>[];
  getRowId: GetRowIdFunc<T>;
  pinnedBottom?: Partial<T>[];
  quickFilter?: string;
  label: string;
  emptyText: string;
  maxRows?: number;
  floatingFilters?: boolean;
}

export function DataGrid<T>({ rows, columns, getRowId, pinnedBottom, quickFilter, label, emptyText, maxRows = 10, floatingFilters = true }: Props<T>) {
  const [api, setApi] = useState<GridApi<T> | null>(null);
  const count = rows?.length ?? 0;
  const visible = Math.max(2, Math.min(maxRows, count));
  const height = HEADER_H + (floatingFilters ? FLOAT_H : 0) + visible * ROW_H + (pinnedBottom?.length ? pinnedBottom.length * ROW_H : 0) + 4;

  const defaultColDef = useMemo<ColDef<T>>(
    () => ({
      sortable: true,
      resizable: true,
      filter: true,
      suppressMovable: true,
      floatingFilter: floatingFilters,
      minWidth: 90,
      suppressFloatingFilterButton: true,
      suppressHeaderFilterButton: true,
    }),
    [floatingFilters],
  );

  useEffect(() => {
    api?.setGridOption("quickFilterText", quickFilter ?? "");
  }, [api, quickFilter]);

  return (
    <div className="grid-wrap" style={{ height }} role="region" aria-label={label}>
      <AgGridReact<T>
        theme={recourseTheme}
        rowData={rows ?? []}
        columnDefs={columns}
        defaultColDef={defaultColDef}
        getRowId={getRowId}
        {...(pinnedBottom ? { pinnedBottomRowData: pinnedBottom } : {})}
        loading={rows === null}
        animateRows
        enableCellTextSelection
        headerHeight={HEADER_H}
        floatingFiltersHeight={FLOAT_H}
        rowHeight={ROW_H}
        suppressMovableColumns
        tooltipShowDelay={300}
        overlayNoRowsTemplate={`<span class="grid-empty">${emptyText}</span>`}
        onGridReady={(e: GridReadyEvent<T>) => setApi(e.api)}
      />
    </div>
  );
}
