import React, { useMemo, useState } from 'react';
import { FileDown, Plus, ChevronDown, ChevronRight, Pencil, Trash2, FolderPlus } from 'lucide-react';
import { formatCurrency } from '../utils';
import { Modal } from '../components/ui';
import * as XLSX from 'xlsx';
import { loadCostCodes, projectNameOf } from '../services/masterData';
import { getActiveProject } from '../services/projectScope';
import { confirmDialog, destroyDialog, notify } from '../components/ui/DialogHost';
import type { AppBOQItem, AppBOQSection } from '../types';
import {
  EMPTY_ITEM_DRAFT,
  EMPTY_SECTION_DRAFT,
  addItem as addBoqItem,
  addSection as addBoqSection,
  amountOf,
  boqTotal,
  codeKey,
  draftFromItem,
  draftFromSection,
  findItem,
  findSectionOfItem,
  removeItem as removeBoqItem,
  removeSection as removeBoqSection,
  sectionTotal,
  updateItem as updateBoqItem,
  updateSection as updateBoqSection,
  validateItemDraft,
  validateSectionDraft,
  type BoqItemDraft,
  type BoqSectionDraft,
} from '../services/boq/boqModel';

type ItemModal = { mode: 'add'; sectionId: string } | { mode: 'edit'; itemId: string } | null;
type SectionModal = { mode: 'add' } | { mode: 'edit'; sectionId: string } | null;

const numberText = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '0');

export default function BOQPage(props: { boqData: AppBOQSection[]; setBoqData: (next: AppBOQSection[]) => void }) {
  const { boqData = [], setBoqData } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set(boqData.map((s) => s.id)));
  const [showImport, setShowImport] = useState(false);
  const [itemModal, setItemModal] = useState<ItemModal>(null);
  const [sectionModal, setSectionModal] = useState<SectionModal>(null);
  const [itemDraft, setItemDraft] = useState<BoqItemDraft>(EMPTY_ITEM_DRAFT);
  const [sectionDraft, setSectionDraft] = useState<BoqSectionDraft>(EMPTY_SECTION_DRAFT);
  const [itemSectionId, setItemSectionId] = useState('');
  const [itemErrors, setItemErrors] = useState<string[]>([]);
  const [sectionErrors, setSectionErrors] = useState<string[]>([]);

  // Fixing a field clears the complaint about it: a message that stays after
  // the input is corrected reads as "it is still wrong" and gets ignored.
  const editSectionDraft = (patch: Partial<BoqSectionDraft>) => {
    setSectionDraft((prev) => ({ ...prev, ...patch }));
    setSectionErrors([]);
  };

  const editItemDraft = (patch: Partial<BoqItemDraft>) => {
    setItemDraft((prev) => ({ ...prev, ...patch }));
    setItemErrors([]);
  };

  const projectId = getActiveProject();
  const projectName = projectNameOf(projectId);
  const totalEstimated = useMemo(() => boqTotal(boqData), [boqData]);

  const toggleSection = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openAddSection = () => {
    setSectionDraft(EMPTY_SECTION_DRAFT);
    setSectionErrors([]);
    setSectionModal({ mode: 'add' });
  };

  const openEditSection = (section: AppBOQSection) => {
    setSectionDraft(draftFromSection(section));
    setSectionErrors([]);
    setSectionModal({ mode: 'edit', sectionId: section.id });
  };

  const openAddItem = (sectionId?: string) => {
    setItemDraft(EMPTY_ITEM_DRAFT);
    setItemSectionId(sectionId || boqData[0]?.id || '');
    setItemErrors([]);
    setItemModal({ mode: 'add', sectionId: sectionId || boqData[0]?.id || '' });
  };

  const openEditItem = (item: AppBOQItem) => {
    const owner = findSectionOfItem(boqData, item.id);
    if (!owner) return;
    setItemDraft(draftFromItem(item));
    setItemSectionId(owner.id);
    setItemErrors([]);
    setItemModal({ mode: 'edit', itemId: item.id });
  };

  const saveSection = () => {
    if (!sectionModal) return;
    const errors = validateSectionDraft(
      boqData,
      sectionDraft,
      sectionModal.mode === 'edit' ? sectionModal.sectionId : undefined
    );
    if (errors.length > 0) {
      setSectionErrors(errors);
      return;
    }
    if (sectionModal.mode === 'edit') {
      setBoqData(updateBoqSection(boqData, sectionModal.sectionId, sectionDraft));
      notify('Section updated.');
      setSectionModal(null);
      return;
    }
    const { sections, section } = addBoqSection(boqData, sectionDraft);
    setBoqData(sections);
    setExpanded((prev) => new Set(prev).add(section.id));
    setSectionModal(null);
    notify(`Section "${section.sectionCode}" added. Now add its first item.`);
    // A section with no items is not useful yet: take the person straight to
    // the item form, already pointed at the section they just created.
    openAddItem(section.id);
  };

  const saveItem = async () => {
    if (!itemModal) return;
    if (boqData.length === 0) {
      setItemErrors(['Add a section first — every BOQ item belongs to one.']);
      return;
    }
    const errors = validateItemDraft(
      boqData,
      itemDraft,
      itemSectionId,
      itemModal.mode === 'edit' ? itemModal.itemId : undefined
    );
    if (errors.length > 0) {
      setItemErrors(errors);
      return;
    }
    if (itemModal.mode === 'edit') {
      const original = findItem(boqData, itemModal.itemId);
      if (
        original &&
        codeKey(original.itemCode) !== codeKey(itemDraft.itemCode) &&
        (Number(original.completedQuantity) || 0) > 0
      ) {
        const ok = await confirmDialog({
          title: 'Change item code',
          message: `"${original.itemCode}" already has work recorded against it.\n\nChanging the code to "${itemDraft.itemCode.trim()}" means existing daily reports and bills under the old code will no longer match this BOQ line.`,
          confirmLabel: 'Change code anyway',
        });
        if (!ok) return;
      }
      setBoqData(updateBoqItem(boqData, itemModal.itemId, itemDraft, itemSectionId));
      notify(`Item "${itemDraft.itemCode.trim()}" updated.`);
    } else {
      const { sections, item } = addBoqItem(boqData, itemSectionId, itemDraft);
      setBoqData(sections);
      setExpanded((prev) => new Set(prev).add(itemSectionId));
      notify(`Item "${item.itemCode}" added.`);
    }
    setItemModal(null);
  };

  const deleteItem = async (item: AppBOQItem) => {
    const ok = await destroyDialog({
      title: 'Delete BOQ item',
      message: `Delete "${item.itemCode}" — ${item.description}?\n\nDaily reports and bills that already used this code keep their history, but will no longer match a BOQ line.`,
      confirmLabel: 'Delete item',
    });
    if (!ok) return;
    setBoqData(removeBoqItem(boqData, item.id));
    notify(`Item "${item.itemCode}" deleted.`);
  };

  const deleteSection = async (section: AppBOQSection) => {
    const count = section.children.length;
    const ok = await destroyDialog({
      title: 'Delete BOQ section',
      message:
        count > 0
          ? `Delete section "${section.sectionCode} — ${section.description}" and its ${count} item${count === 1 ? '' : 's'}?`
          : `Delete section "${section.sectionCode} — ${section.description}"?`,
      confirmLabel: 'Delete section',
    });
    if (!ok) return;
    setBoqData(removeBoqSection(boqData, section.id));
    notify(`Section "${section.sectionCode}" deleted.`);
  };

  const editingItem = itemModal?.mode === 'edit' ? findSectionOfItem(boqData, itemModal.itemId)?.children.find((i) => i.id === itemModal.itemId) : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1>Bill of Quantities</h1>
          <p className="text-sm text-gray-500" data-testid="boq-project">
            {projectName && projectName !== projectId ? `${projectId} · ${projectName}` : projectId}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium"
          >
            <FileDown className="w-4 h-4" /> Import Excel
          </button>
          <button
            onClick={openAddSection}
            data-testid="add-section"
            className="flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium"
          >
            <FolderPlus className="w-4 h-4" /> Add Section
          </button>
          <button
            onClick={() => openAddItem()}
            data-testid="add-item"
            className="flex items-center gap-1.5 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            <Plus className="w-4 h-4" /> Add BOQ Item
          </button>
        </div>
      </div>

      {boqData.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center" data-testid="boq-empty">
          <div className="mx-auto w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mb-3">
            <FolderPlus className="w-6 h-6 text-amber-600" />
          </div>
          <h2 className="text-lg font-bold text-gray-900">Start your bill of quantities</h2>
          <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
            A BOQ is organised into sections (for example <span className="font-medium text-gray-700">R — Road and bridge works</span>).
            Create the first section, then add its items with quantity and rate. Items feed DSR, billing and job costing.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <button onClick={openAddSection} className="inline-flex items-center gap-1.5 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium">
              <FolderPlus className="w-4 h-4" /> Add first section
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left font-semibold text-gray-600 w-24">Code</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Description</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600 w-16">Unit</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600 w-28">Est. Qty</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600 w-28">Rate</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600 w-32">Amount</th>
                  <th className="px-4 py-3 w-24"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {boqData.map((section) => (
                  <React.Fragment key={section.id}>
                    <tr className="bg-slate-100 hover:bg-slate-200 border-b border-slate-200">
                      <td className="px-4 py-3 font-bold text-slate-800">
                        <button
                          type="button"
                          onClick={() => toggleSection(section.id)}
                          aria-expanded={expanded.has(section.id)}
                          aria-label={`${expanded.has(section.id) ? 'Collapse' : 'Expand'} section ${section.sectionCode}`}
                          className="flex items-center gap-2 text-left w-full"
                        >
                          {expanded.has(section.id) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          <span>{section.sectionCode}</span>
                        </button>
                      </td>
                      <td className="px-4 py-3 font-bold text-slate-800">
                        {section.description}
                        <span className="ml-2 text-xs font-normal text-slate-500">
                          {section.children.length} item{section.children.length === 1 ? '' : 's'}
                        </span>
                      </td>
                      <td className="px-4 py-3"></td>
                      <td className="px-4 py-3"></td>
                      <td className="px-4 py-3"></td>
                      <td className="px-4 py-3 text-right font-bold text-slate-800">{formatCurrency(sectionTotal(section))}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => openEditSection(section)}
                            aria-label={`Rename section ${section.sectionCode}`}
                            title="Rename section"
                            className="p-1.5 rounded-md text-slate-600 hover:bg-white hover:text-amber-700"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteSection(section)}
                            aria-label={`Delete section ${section.sectionCode}`}
                            title="Delete section"
                            className="p-1.5 rounded-md text-slate-600 hover:bg-white hover:text-rose-600"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded.has(section.id) &&
                      section.children.map((item) => (
                        <tr key={item.id} className="hover:bg-amber-50/50 border-b border-gray-100">
                          <td className="px-4 py-2.5 text-gray-600 font-mono text-xs pl-10">{item.itemCode}</td>
                          <td className="px-4 py-2.5 text-gray-800">{item.description}</td>
                          <td className="px-4 py-2.5 text-gray-600">{item.unit}</td>
                          <td className="px-4 py-2.5 text-right text-gray-700">{numberText(item.estimatedQuantity)}</td>
                          <td className="px-4 py-2.5 text-right text-gray-700">{numberText(item.rate)}</td>
                          <td className="px-4 py-2.5 text-right font-medium text-gray-900">{formatCurrency(amountOf(item))}</td>
                          <td className="px-4 py-2">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => openEditItem(item)}
                                aria-label={`Edit item ${item.itemCode}`}
                                title="Edit item"
                                className="p-1.5 rounded-md text-gray-500 hover:bg-white hover:text-amber-700"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void deleteItem(item)}
                                aria-label={`Delete item ${item.itemCode}`}
                                title="Delete item"
                                className="p-1.5 rounded-md text-gray-500 hover:bg-white hover:text-rose-600"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    {expanded.has(section.id) && section.children.length === 0 && (
                      <tr className="border-b border-gray-100">
                        <td colSpan={7} className="px-4 py-3 pl-10 text-xs text-gray-500">
                          No items in this section yet.
                          <button type="button" onClick={() => openAddItem(section.id)} className="ml-1 font-medium text-amber-700 hover:underline">
                            Add the first item
                          </button>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
              <tbody>
                <tr>
                  <td colSpan={6} className="px-4 py-3 text-right font-semibold text-white bg-slate-800">
                    Grand Total:
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-lg text-white bg-slate-800">{formatCurrency(totalEstimated)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {sectionModal && (
        <Modal
          isOpen
          onClose={() => setSectionModal(null)}
          title={sectionModal.mode === 'edit' ? 'Rename BOQ Section' : 'Add BOQ Section'}
        >
          <form
            noValidate
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              saveSection();
            }}
          >
            <div>
              <label htmlFor="boq-section-code" className="block text-sm font-medium text-gray-700 mb-1">
                Section code
              </label>
              <input
                id="boq-section-code"
                type="text"
                maxLength={20}
                value={sectionDraft.sectionCode}
                onChange={(e) => editSectionDraft({ sectionCode: e.target.value })}
                placeholder="e.g., R"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="boq-section-description" className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <input
                id="boq-section-description"
                type="text"
                maxLength={200}
                value={sectionDraft.description}
                onChange={(e) => editSectionDraft({ description: e.target.value })}
                placeholder="e.g., Road and bridge works"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            {sectionErrors.length > 0 && (
              <div role="alert" data-testid="boq-section-errors" className="bg-white border border-gray-200 border-l-2 border-l-red-600 rounded-lg p-3">
                {sectionErrors.map((error) => (
                  <p key={error} className="text-sm text-red-700">
                    {error}
                  </p>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setSectionModal(null)} className="px-4 py-2 text-sm text-gray-600">
                Cancel
              </button>
              <button type="submit" className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-800 font-medium">
                {sectionModal.mode === 'edit' ? 'Save changes' : 'Add section'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {itemModal && (
        <Modal isOpen onClose={() => setItemModal(null)} title={itemModal.mode === 'edit' ? 'Edit BOQ Item' : 'Add New BOQ Item'}>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void saveItem();
            }}
          >
            {boqData.length === 0 ? (
              <div className="bg-white border border-gray-200 border-l-2 border-l-amber-600 rounded-lg p-3">
                <p className="text-sm text-amber-800">A BOQ item belongs to a section, and this BOQ has none yet.</p>
                <button
                  type="button"
                  onClick={() => {
                    setItemModal(null);
                    openAddSection();
                  }}
                  className="mt-2 text-sm font-medium text-amber-800 underline"
                >
                  Create the first section
                </button>
              </div>
            ) : (
              <>
                <div>
                  <label htmlFor="boq-item-section" className="block text-sm font-medium text-gray-700 mb-1">
                    Section
                  </label>
                  <select
                    id="boq-item-section"
                    value={itemSectionId}
                    onChange={(e) => { setItemSectionId(e.target.value); setItemErrors([]); }}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">Select section…</option>
                    {boqData.map((section) => (
                      <option key={section.id} value={section.id}>
                        {section.sectionCode} — {section.description}
                      </option>
                    ))}
                  </select>
                  {itemModal.mode === 'edit' && (
                    <p className="text-xs text-gray-400 mt-1">Changing the section moves this item, with its recorded work, to the new section.</p>
                  )}
                </div>
                <div>
                  <label htmlFor="boq-item-code" className="block text-sm font-medium text-gray-700 mb-1">
                    Item code
                  </label>
                  <input
                    id="boq-item-code"
                    type="text"
                    maxLength={40}
                    value={itemDraft.itemCode}
                    onChange={(e) => editItemDraft({ itemCode: e.target.value })}
                    placeholder="e.g., R-104"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label htmlFor="boq-item-description" className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <input
                    id="boq-item-description"
                    type="text"
                    maxLength={200}
                    value={itemDraft.description}
                    onChange={(e) => editItemDraft({ description: e.target.value })}
                    placeholder="Item description"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="boq-item-unit" className="block text-sm font-medium text-gray-700 mb-1">
                      Unit
                    </label>
                    <input
                      id="boq-item-unit"
                      type="text"
                      maxLength={16}
                      value={itemDraft.unit}
                      onChange={(e) => editItemDraft({ unit: e.target.value })}
                      placeholder="m³, kg"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="boq-item-quantity" className="block text-sm font-medium text-gray-700 mb-1">
                      Quantity
                    </label>
                    <input
                      id="boq-item-quantity"
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={itemDraft.quantity}
                      onChange={(e) => editItemDraft({ quantity: e.target.value })}
                      placeholder="0"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="boq-item-rate" className="block text-sm font-medium text-gray-700 mb-1">
                      Rate (NRS)
                    </label>
                    <input
                      id="boq-item-rate"
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={itemDraft.rate}
                      onChange={(e) => editItemDraft({ rate: e.target.value })}
                      placeholder="0"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <span className="block text-sm font-medium text-gray-700 mb-1">Amount</span>
                    <div className="px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg text-gray-700" data-testid="boq-item-amount-preview">
                      {formatCurrency((Number(itemDraft.quantity) || 0) * (Number(itemDraft.rate) || 0))}
                    </div>
                  </div>
                </div>
                <div>
                  <label htmlFor="boq-item-cost-code" className="block text-sm font-medium text-gray-700 mb-1">
                    Cost code (for job costing)
                  </label>
                  <select
                    id="boq-item-cost-code"
                    value={itemDraft.costCode}
                    onChange={(e) => editItemDraft({ costCode: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">Unassigned</option>
                    {loadCostCodes().map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code} · {c.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-400 mt-1">Tags this item&apos;s budget so cost-code variances can be reported.</p>
                </div>
                {editingItem && (
                  <p className="text-xs text-gray-500">
                    This item already has {numberText(editingItem.completedQuantity)} {editingItem.unit || 'units'} of work recorded; editing the contract quantity does not
                    change that.
                  </p>
                )}
              </>
            )}
            {itemErrors.length > 0 && (
              <div role="alert" data-testid="boq-item-errors" className="bg-white border border-gray-200 border-l-2 border-l-red-600 rounded-lg p-3">
                {itemErrors.map((error) => (
                  <p key={error} className="text-sm text-red-700">
                    {error}
                  </p>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setItemModal(null)} className="px-4 py-2 text-sm text-gray-600">
                Cancel
              </button>
              <button
                type="submit"
                disabled={boqData.length === 0}
                className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-800 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {itemModal.mode === 'edit' ? 'Save changes' : 'Add Item'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showImport && (
        <Modal isOpen onClose={() => setShowImport(false)} title="Import BOQ from Excel">
          <ImportExcelModal
            boqData={boqData}
            setBoqData={(next: AppBOQSection[]) => {
              setBoqData(next);
              // Replacing the document must not leave every new section collapsed.
              setExpanded(new Set(next.map((section) => section.id)));
            }}
            onClose={() => setShowImport(false)}
          />
        </Modal>
      )}
    </div>
  );
}

function ImportExcelModal({ boqData, setBoqData, onClose }: any) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parsedData, setParsedData] = useState<any>(null);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'select' | 'preview'>('select');

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const sheetName = workbook.SheetNames.find((n: any) => n.includes('Work_Sheet1')) || workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as any[][];
        if (rows.length < 2) {
          setError('Excel file is empty.');
          return;
        }
        const result = parseOfficialBOQTemplate(rows);
        if (result.errors.length > 0 && result.sections.length === 0) {
          setError(`Unsupported format: ${result.errors[0].reason}`);
          return;
        }
        setParsedData(result);
        setStep('preview');
      } catch (err) {
        setError('Error reading Excel file.');
        console.error(err);
      }
    };
    reader.readAsBinaryString(file);
  };

  const parseOfficialBOQTemplate = (rows: any[][]) => {
    const sections: any[] = [];
    const errors: any[] = [];
    let currentSection: any = null;
    let sectionCounter = 0;
    let itemCounter = 0;
    const headerRow = rows[0];
    const headerMap: any = {};
    headerRow.forEach((cell: any, idx: number) => {
      if (cell && typeof cell === 'string') {
        headerMap[cell.trim().toLowerCase()] = idx;
      }
    });
    const hasSector = 'sector' in headerMap;
    const hasItemName = 'item name & description' in headerMap;
    const hasUnit = 'unit' in headerMap;
    const hasQuantity = 'quantity' in headerMap;
    const hasRate = "bidder's rate" in headerMap;
    const hasBOQID = 'boq id' in headerMap;
    const hasLegacyItemCode = 'item code' in headerMap;
    const hasLegacyDescription = 'description' in headerMap;
    const costCodeCol = 'cost code' in headerMap ? headerMap['cost code'] : 'costcode' in headerMap ? headerMap['costcode'] : -1;

    if (!hasItemName && !hasLegacyDescription)
      return { sections: [], errors: [{ rowNumber: 1, reason: 'Missing required header "Item Name & Description" or "Description"' }], totalItems: 0, grandTotal: 0 };
    if (!hasQuantity) return { sections: [], errors: [{ rowNumber: 1, reason: 'Missing required header "Quantity"' }], totalItems: 0, grandTotal: 0 };
    if (!hasRate && !('rate' in headerMap))
      return { sections: [], errors: [{ rowNumber: 1, reason: 'Missing required header "Bidder\'s Rate" or "Rate"' }], totalItems: 0, grandTotal: 0 };

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 1;
      if (!row || row.every((cell: any) => !cell || cell === '')) continue;
      const sector = hasSector ? String(row[headerMap['sector']] || '').trim() : '';
      const itemName = hasItemName ? String(row[headerMap['item name & description']] || '').trim() : hasLegacyDescription ? String(row[headerMap['description']] || '').trim() : '';
      const unit = hasUnit ? String(row[headerMap['unit']] || '').trim() : '';
      const quantityRaw = hasQuantity ? row[headerMap['quantity']] : row[headerMap['quantity']];
      const rateRaw = hasRate ? row[headerMap["bidder's rate"]] : row[headerMap['rate']];
      const boqId = hasBOQID ? String(row[headerMap['boq id']] || '').trim() : '';
      if (sector && sector !== '') {
        const sectorMatch = sector.match(/^(.*?)\s*#\[(.*?)\]$/);
        let sectorName = sector;
        let sectorBudget: number | null = null;
        if (sectorMatch) {
          sectorName = sectorMatch[1].trim();
          const budgetNum = parseFloat(sectorMatch[2].trim());
          sectorBudget = isNaN(budgetNum) ? null : budgetNum;
        }
        sectionCounter++;
        itemCounter = 0;
        currentSection = { id: `import-section-${sectionCounter}`, sectionCode: String(sectionCounter), description: sectorName, budget: sectorBudget, items: [] };
        sections.push(currentSection);
        continue;
      }
      if (itemName && itemName !== '' && currentSection) {
        itemCounter++;
        const quantity = Math.round(parseFloat(String(quantityRaw)) * 100) / 100;
        const rate = parseFloat(String(rateRaw));
        const amount = Math.round(quantity * rate * 100) / 100;
        if (!unit) {
          errors.push({ rowNumber: rowNum, reason: 'Missing unit' });
          continue;
        }
        if (isNaN(quantity) || quantity <= 0) {
          errors.push({ rowNumber: rowNum, reason: 'Invalid quantity (must be > 0)' });
          continue;
        }
        if (isNaN(rate) || rate < 0) {
          errors.push({ rowNumber: rowNum, reason: 'Invalid rate (must be >= 0)' });
          continue;
        }
        const itemCode = `${currentSection.sectionCode}.${String(itemCounter).padStart(2, '0')}`;
        currentSection.items.push({
          id: `import-item-${sectionCounter}-${itemCounter}`,
          sectionCode: currentSection.sectionCode,
          itemCode,
          description: itemName,
          unit,
          estimatedQuantity: quantity,
          rate,
          amount,
          actualMaterialCost: 0,
          actualLaborCost: 0,
          completedQuantity: 0,
          costCode: costCodeCol >= 0 ? String(row[costCodeCol] || '').trim() || undefined : undefined,
          boqId: boqId || undefined,
        });
      }
    }
    const totalItems = sections.reduce((sum: number, s: any) => sum + s.items.length, 0);
    const grandTotal = sections.reduce((sum: number, s: any) => sum + s.items.reduce((itemSum: number, item: any) => itemSum + item.amount, 0), 0);
    return { sections, errors, totalItems, grandTotal };
  };

  const handleImport = async () => {
    if (!parsedData || parsedData.sections.length === 0) {
      setError('No valid data to import.');
      return;
    }
    const ok = await destroyDialog({
      title: 'Import BOQ',
      message: `Import ${parsedData.totalItems} items in ${parsedData.sections.length} sections?\n\nThis will REPLACE the existing BOQ data.`,
      confirmLabel: 'Import & replace',
    });
    if (!ok) return;
    const newBoqData: any[] = parsedData.sections.map((section: any) => ({
      id: section.id,
      sectionCode: section.sectionCode,
      description: section.description,
      amount: section.budget || section.items.reduce((sum: number, item: any) => sum + item.amount, 0),
      isSection: true,
      children: section.items,
    }));
    setBoqData(newBoqData);
    onClose();
  };

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800 font-medium mb-2">Official BOQ Template Format:</p>
        <ul className="text-xs text-blue-700 space-y-1">
          <li>• Sector rows create sections (e.g., &quot;Construction work #[45000000]&quot;)</li>
          <li>• Item rows belong to the current sector</li>
          <li>• Required columns: Item Name &amp; Description, Unit, Quantity, Bidder&apos;s Rate</li>
          <li>• Optional: BOQ ID for reference. Empty rows are automatically skipped.</li>
        </ul>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Select Excel File</label>
        {step === 'select' ? (
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileSelect}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-amber-50 file:text-amber-700 hover:file:bg-amber-100"
          />
        ) : (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <p className="text-sm text-green-800 font-medium mb-2">Parse Successful</p>
            <div className="grid grid-cols-3 gap-4 text-xs">
              <div>
                <p className="text-green-600">Sections</p>
                <p className="text-lg font-bold text-green-900">{parsedData.sections.length}</p>
              </div>
              <div>
                <p className="text-green-600">Total Items</p>
                <p className="text-lg font-bold text-green-900">{parsedData.totalItems}</p>
              </div>
              <div>
                <p className="text-green-600">Grand Total</p>
                <p className="text-lg font-bold text-green-900">{formatCurrency(parsedData.grandTotal)}</p>
              </div>
            </div>
            {parsedData.errors.length > 0 && (
              <div className="bg-white border border-gray-200 border-l-2 border-l-amber-600 rounded-lg p-3 mt-3">
                <p className="text-sm text-amber-800 font-medium mb-2">Validation Warnings ({parsedData.errors.length})</p>
                <div className="max-h-32 overflow-y-auto">
                  {parsedData.errors.slice(0, 10).map((err: any, idx: number) => (
                    <p key={idx} className="text-xs text-amber-700">
                      Row {err.rowNumber}: {err.reason}
                    </p>
                  ))}
                  {parsedData.errors.length > 10 && <p className="text-xs text-amber-600 mt-1">... and {parsedData.errors.length - 10} more warnings</p>}
                </div>
              </div>
            )}
          </div>
        )}
        {selectedFile && step === 'select' && <p className="text-xs text-gray-500 mt-2">Selected: {selectedFile.name}</p>}
      </div>
      {error && (
        <div className="bg-white border border-gray-200 border-l-2 border-l-red-600 rounded-lg p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}
      {parsedData && parsedData.sections.length > 0 && (
        <div className="border border-gray-200 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left">Section</th>
                <th className="px-3 py-2 text-right">Items</th>
                <th className="px-3 py-2 text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {parsedData.sections.map((section: any, idx: number) => (
                <tr key={idx} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium">{section.description}</td>
                  <td className="px-3 py-2 text-right">{section.items.length}</td>
                  <td className="px-3 py-2 text-right font-medium">{formatCurrency(section.items.reduce((sum: number, item: any) => sum + item.amount, 0))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 font-semibold">
              <tr>
                <td className="px-3 py-2">Grand Total</td>
                <td className="px-3 py-2 text-right">{parsedData.totalItems}</td>
                <td className="px-3 py-2 text-right">{formatCurrency(parsedData.grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <div className="flex justify-end gap-2 pt-4 border-t border-gray-100">
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">
          Cancel
        </button>
        <button
          onClick={handleImport}
          disabled={!parsedData || parsedData.sections.length === 0}
          className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-800 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Import BOQ
        </button>
      </div>
    </div>
  );
}
