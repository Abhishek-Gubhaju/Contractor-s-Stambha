// @vitest-environment jsdom
// One job, one complete set of records. Switching jobs must swap the ledger,
// finance, masters and the printed letterhead — while sign-in, security and
// machine preferences stay exactly where they are.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SCOPED_BASES,
  SCOPE_OWNER_KEY,
  getActiveProject,
  migrateProjectScope,
  readScoped,
  scopeOwner,
  setActiveProject,
} from './projectScope';
import { RESTORABLE_KEYS } from './backup/backupService';
import { allEntries, saveEntry } from './booksService';
import { EMPTY_COMPANY, loadCompany, saveCompany } from './companyService';
import { loadParties, upsertParty } from './partyService';
import { loadCostCodes, saveCostCodes, SEED_COST_CODES } from './masterData';
import { loadTaxSettings, saveTaxSettings } from './taxService';
import { loadCommitments, upsertCommitment } from './commitments';
import { loadStockItems, upsertStockItem } from './stockService';
import { allDocItems, saveDocItems, blankItem } from './documentService';
import { upsertProject } from './masterData';

const D = '2025-04-20';

beforeEach(() => {
  localStorage.clear();
  setActiveProject('PRJ-001');
});

function post(project: string, amount: number, supplier = 'Sample Steel') {
  return saveEntry('expense-paid', {
    date: D,
    category: 'Materials',
    amount,
    method: 'cash',
    project,
    supplier,
  });
}

describe('ledger and finance are per job', () => {
  it('keeps entries and balances of two jobs completely apart', () => {
    post('PRJ-001', 500);
    expect(allEntries()).toHaveLength(1);
    expect(allEntries()[0].id).toContain('EX-');

    setActiveProject('PRJ-002');
    expect(allEntries()).toEqual([]);

    post('PRJ-002', 900);
    expect(allEntries()).toHaveLength(1);

    setActiveProject('PRJ-001');
    expect(allEntries()).toHaveLength(1);
    expect(readScoped<any[]>('contractoros_entry_lines', []).every((l) => l.project_id === 'PRJ-001')).toBe(true);
  });

  it('scopes the item lines that ride with an entry', () => {
    saveDocItems('E-1', [blankItem({ description: 'Cement', amount: 5000 })]);
    expect(allDocItems()).toHaveLength(1);

    setActiveProject('PRJ-002');
    expect(allDocItems()).toEqual([]);
  });

  it('scopes commitments and stock', () => {
    upsertCommitment({ ref: 'PO-1', vendor: 'A', project_id: 'PRJ-001', amount: 500, status: 'approved' });
    upsertStockItem({ name: 'Cement', unit: 'bag', costCode: 'Materials' });

    setActiveProject('PRJ-002');
    expect(loadCommitments()).toEqual([]);
    expect(loadStockItems()).toEqual([]);
  });
});

describe('masters and identity are per job', () => {
  it('gives each job its own letterhead', () => {
    saveCompany({ name: 'Rai Constructions', pan: '123456789', address: 'Lalitpur' });
    expect(loadCompany().name).toBe('Rai Constructions');

    setActiveProject('PRJ-002');
    expect(loadCompany()).toEqual(EMPTY_COMPANY);

    saveCompany({ name: 'Himalaya Builders', pan: '987654321', logo: 'data:image/png;base64,AAAA' });
    expect(loadCompany().name).toBe('Himalaya Builders');

    setActiveProject('PRJ-001');
    expect(loadCompany().name).toBe('Rai Constructions');
    expect(loadCompany().pan).toBe('123456789');

    setActiveProject('PRJ-002');
    expect(loadCompany().logo).toBe('data:image/png;base64,AAAA');
  });

  it('gives each job its own parties, cost codes and tax settings', () => {
    upsertParty({ name: 'Nepal Traders', type: 'supplier', pan: '111111111' });
    saveCostCodes([{ code: '0100', name: 'Only this job', kind: 'material' }]);
    saveTaxSettings({ vatEnabled: false, vatRate: 0, tdsEnabled: false, tdsRate: 0 });

    setActiveProject('PRJ-002');
    expect(loadParties()).toEqual([]);
    expect(loadCostCodes().map((c) => c.code)).toEqual(SEED_COST_CODES.map((c) => c.code));
    expect(loadTaxSettings().vatEnabled).toBe(true); // default, not job 1's choice

    upsertParty({ name: 'Hill Quarry', type: 'supplier' });
    expect(loadParties().map((p) => p.name)).toEqual(['Hill Quarry']);

    setActiveProject('PRJ-001');
    expect(loadParties().map((p) => p.name)).toEqual(['Nepal Traders']);
    expect(loadCostCodes().map((c) => c.code)).toEqual(['0100']);
    expect(loadTaxSettings().vatEnabled).toBe(false);
  });
});

describe('backup coverage', () => {
  it('can back up and restore every project-scoped store', () => {
    // The backup layout keeps its own list (folders and file names); this guard
    // fails if a new scoped store is added without a restorable backup entry.
    expect(SCOPED_BASES.filter((base) => !RESTORABLE_KEYS.has(base))).toEqual([]);
  });
});

describe('upgrading data written before jobs were isolated', () => {
  it('gives unscoped records to the job that was open, and only to it', () => {
    // A pre-scoping install: the letterhead and books sit under the bare keys.
    localStorage.setItem('contractoros_company', JSON.stringify({ ...EMPTY_COMPANY, name: 'Legacy Firm' }));
    localStorage.setItem('contractoros_entries', JSON.stringify([{ id: 'LEG-1' }]));
    setActiveProject('PRJ-002');

    migrateProjectScope();

    expect(scopeOwner()).toBe('PRJ-002');
    expect(localStorage.getItem(SCOPE_OWNER_KEY)).toBe('PRJ-002');
    expect(loadCompany().name).toBe('Legacy Firm');

    setActiveProject('PRJ-001');
    expect(loadCompany()).toEqual(EMPTY_COMPANY);
    expect(allEntries()).toEqual([]);
  });

  it('never copies a base that another job already adopted', () => {
    upsertProject({ id: 'PRJ-001', name: 'One', client: '', status: 'active', startDate: '', endDate: '' });
    saveCompany({ name: 'Job one firm', pan: '1' });
    const before = localStorage.getItem('contractoros_company::PRJ-001');

    migrateProjectScope();

    expect(localStorage.getItem('contractoros_company::PRJ-001')).toBe(before);
    expect(loadCompany().name).toBe('Job one firm');
    expect(getActiveProject()).toBe('PRJ-001');
  });
});
