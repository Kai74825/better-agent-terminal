# 工作區 Archive 與排序功能實現計劃

## 功能需求

1. **Archive（歸檔）功能**：暫時隱藏工作區，並可從特定位置恢復
   - 歸檔時終端進程保持運行，只隱藏顯示
2. **排序功能**：允許用戶透過拖拽自定義工作區的顯示順序

---

## 實現方案

### 1. 數據結構修改

**文件：** `src/types/index.ts`

```typescript
export interface Workspace {
  id: string;
  name: string;
  alias?: string;
  role?: string;
  folderPath: string;
  createdAt: number;
  archived?: boolean;    // 新增：是否已歸檔
  order?: number;        // 新增：排序順序
}
```

### 2. workspace-store 新增方法

**文件：** `src/stores/workspace-store.ts`

- `archiveWorkspace(id: string)` - 歸檔工作區
- `unarchiveWorkspace(id: string)` - 取消歸檔
- `reorderWorkspaces(workspaceIds: string[])` - 重新排序
- `getActiveWorkspaces()` - 取得非歸檔的工作區
- `getArchivedWorkspaces()` - 取得已歸檔的工作區

### 3. Sidebar UI 修改

**文件：** `src/components/Sidebar.tsx`

#### 3.1 工作區列表分區
- 上方：活動工作區（未歸檔）
- 下方：可折疊的「已歸檔」區塊

#### 3.2 歸檔操作
- 在工作區項目上添加「歸檔」按鈕（圖標：📦 或類似）
- 在已歸檔區塊的項目上添加「恢復」按鈕

#### 3.3 拖拽排序（採用）
- 使用原生 HTML5 Drag and Drop API
- 拖拽時顯示插入位置指示器
- 放開時更新順序

#### 3.4 歸檔行為
- 歸檔只設置 `archived: true`，不停止終端進程
- 恢復時工作區立即可用，終端狀態保持

### 4. 樣式更新

**文件：** `src/index.css`

- 歸檔區塊的折疊/展開樣式
- 拖拽狀態的視覺反饋
- 已歸檔工作區的淡化顯示

---

## 修改文件清單

| 文件 | 修改內容 |
|------|----------|
| `src/types/index.ts` | 添加 `archived` 和 `order` 屬性 |
| `src/stores/workspace-store.ts` | 添加歸檔和排序方法 |
| `src/components/Sidebar.tsx` | UI 分區、歸檔按鈕、拖拽排序 |
| `src/index.css` | 新增相關樣式 |

---

## UI 設計概念

```
┌─────────────────────────┐
│ Workspaces              │
├─────────────────────────┤
│ ≡ Project A     [📦][×] │  ← 拖拽手柄、歸檔、刪除
│ ≡ Project B     [📦][×] │
│ ≡ Project C     [📦][×] │
├─────────────────────────┤
│ ▼ Archived (2)          │  ← 可折疊區塊
│   Project D     [↩][×]  │  ← 恢復按鈕
│   Project E     [↩][×]  │
├─────────────────────────┤
│ + Add Workspace         │
└─────────────────────────┘
```

---

## 實作步驟

1. 修改 `Workspace` 類型定義
2. 在 `workspace-store` 添加歸檔/排序方法
3. 更新 `Sidebar` 組件實現 UI 分區
4. 實現歸檔/恢復按鈕功能
5. 實現拖拽排序功能
6. 添加 CSS 樣式
7. 測試完整流程
