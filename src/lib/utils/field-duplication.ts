import type { FieldPlacement } from "../schemas/field.ts";

export type CopyableField = FieldPlacement & { id: string };

function copyToPage(
  fields: readonly CopyableField[],
  page: number,
  createId: () => string,
  offset: { x: number; y: number },
): CopyableField[] {
  const groupIds = new Map<string, string>();

  return fields.map((field) => {
    const width = Math.min(1, field.width);
    const height = Math.min(1, field.height);
    const groupId =
      field.type === "radio" && field.groupId
        ? (groupIds.get(field.groupId) ?? createAndRememberGroupId())
        : undefined;

    function createAndRememberGroupId() {
      const nextId = createId();
      groupIds.set(field.groupId!, nextId);
      return nextId;
    }

    return {
      ...field,
      groupId,
      height,
      id: createId(),
      options: field.options ? [...field.options] : undefined,
      page,
      width,
      x: Math.min(Math.max(field.x + offset.x, 0), 1 - width),
      y: Math.min(Math.max(field.y + offset.y, 0), 1 - height),
    };
  });
}

export function repeatFieldsOnPages(
  fields: readonly CopyableField[],
  targetPages: readonly number[],
  createId: () => string,
): CopyableField[] {
  const sourcePages = new Set(fields.map((field) => field.page));
  const pages = [...new Set(targetPages)].filter((page) => !sourcePages.has(page));

  return pages.flatMap((page) => copyToPage(fields, page, createId, { x: 0, y: 0 }));
}

export function pasteFieldGroup(
  fields: readonly CopyableField[],
  targetPage: number,
  createId: () => string,
  offset: { x: number; y: number } = { x: 0.015, y: 0.015 },
): CopyableField[] {
  return copyToPage(fields, targetPage, createId, offset);
}
