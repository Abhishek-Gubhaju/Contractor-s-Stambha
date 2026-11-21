// ============ APP-SPECIFIC TYPES (from App.tsx) ============

// Page type - re-exported as string union for easy use
export type AppPageType = 'dashboard' | 'boq' | 'job-costing' | 'dsr' | 'attendance' | 'billing' | 'work-progress' | 'ledger' | 'gantt' | 'staff-info' | 'settings';

// App-specific interfaces - exported for page components
export interface AppStaffDocument {
  id: string;
  category: 'Photo' | 'Citizenship Copy' | 'Other';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  dataUrl: string;
}

export interface AppMaterialInvoiceItem {
  id: string;
  serialNo: number;
  hsCode: string;
  description: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
}

export interface AppMaterialInvoice {
  id: string;
  entryCode: string;
  supplierName: string;
  supplierAddress: string;
  supplierVatRegdNo: string;
  supplierPanVatNo: string;
  invoiceNo: string;
  transactionDateBS: string;
  invoiceDate: string;
  buyerName: string;
  buyerAddress: string;
  buyerPanVatNo: string;
  paymentMode: 'Cash' | 'Cheque' | 'Credit' | 'Others';
  items: AppMaterialInvoiceItem[];
  totalAmount: number;
  discount: number;
  taxableAmount: number;
  vatPercent: number;
  vatAmount: number;
  grandTotal: number;
  amountInWords: string;
  attachment?: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    dataUrl: string;
  };
  createdAt: string;
}

export interface AppStaffMember {
  id: string;
  staffCode: string;
  fullName: string;
  trade: string;
  status: 'Active' | 'On Leave' | 'Inactive';
  phone: string;
  email: string;
  address: string;
  joinDate: string;
  monthlySalary: number;
  panNumber: string;
  bankAccountNumber: string;
  bankName: string;
  documents: AppStaffDocument[];
}

export interface AppBOQItem {
  id: string;
  sectionCode: string;
  itemCode: string;
  description: string;
  unit: string;
  estimatedQuantity: number;
  rate: number;
  amount: number;
  actualMaterialCost: number;
  actualLaborCost: number;
  completedQuantity: number;
  /** Cost-code master code this item's cost is budgeted against. */
  costCode?: string;
}

export interface AppBOQSection {
  id: string;
  sectionCode: string;
  description: string;
  amount: number;
  isSection: boolean;
  children: AppBOQItem[];
}

export interface AppLaborer {
  id: string;
  code: string;
  name: string;
  trade: string;
  dailyWage: number;
  status: 'present' | 'absent' | 'leave';
  hoursWorked: number;
  overtimeHours: number;
  assignedBOQItem: string;
  removedDate?: string;
}

export interface AppPurchaseOrder {
  id: string;
  poNumber: string;
  vendor: string;
  date: string;
  status: string;
  totalAmount: number;
}

export interface AppDSRRecord {
  id: string;
  date: string;
  /** Mirrors of the first work item — see dsrService.withMirrors. */
  boqCode: string;
  boqDescription: string;
  workSummary: string;
  workQuantity: number;
  unit: string;
  laborHeadcount: number;
  isSubmitted: boolean;
  /** Document fields written by the daily-report module. */
  reportNo?: string;
  project_id?: string;
  status?: 'draft' | 'submitted' | 'approved';
  weather?: string;
  shift?: string;
  bs_y?: number;
  bs_m?: number;
  bs_d?: number;
  items?: any[];
  labour?: any[];
  plant?: any[];
  materials?: any[];
  tests?: any[];
  delays?: any[];
  safety?: any;
  history?: any[];
}

export interface AppMilestone {
  id: string;
  name: string;
  boqCode: string;
  boqDescription: string;
  startDate: string;
  endDate: string;
  targetQuantity: number;
  unit: string;
  actualQuantity: number;
  status: 'planned' | 'in-progress' | 'completed' | 'delayed';
}

// ============ EXISTING TYPES ============

// Enums
export enum Page {
  Dashboard = 'dashboard',
  BOQ = 'boq',
  JobCosting = 'job-costing',
  DSR = 'dsr',
  Attendance = 'attendance',
  Billing = 'billing',
  WorkProgress = 'work-progress',
  Ledger = 'ledger',
  Gantt = 'gantt',
  StaffInfo = 'staff-info',
  Settings = 'settings',
}

export enum BOQItemType {
  Material = 'material',
  Labor = 'labor',
  Equipment = 'equipment',
  Subcontractor = 'subcontractor',
}

export enum PurchaseOrderStatus {
  Draft = 'draft',
  Pending = 'pending',
  Approved = 'approved',
  Ordered = 'ordered',
  Received = 'received',
  Cancelled = 'cancelled',
}

export enum DSRStatus {
  Draft = 'draft',
  Submitted = 'submitted',
  Approved = 'approved',
  Rejected = 'rejected',
}

export enum AttendanceStatus {
  Present = 'present',
  Absent = 'absent',
  Late = 'late',
  HalfDay = 'half-day',
  Leave = 'leave',
  Holiday = 'holiday',
}

export enum BillingStatus {
  Draft = 'draft',
  Submitted = 'submitted',
  Approved = 'approved',
  Paid = 'paid',
  Rejected = 'rejected',
}

export enum WorkProgressStatus {
  NotStarted = 'not-started',
  InProgress = 'in-progress',
  Completed = 'completed',
  OnHold = 'on-hold',
}

export enum MilestoneStatus {
  Pending = 'pending',
  InProgress = 'in-progress',
  Completed = 'completed',
  Delayed = 'delayed',
}

export enum StaffType {
  Permanent = 'permanent',
  Contract = 'contract',
  DailyWage = 'daily-wage',
  Consultant = 'consultant',
}

export enum StaffStatus {
  Active = 'active',
  Inactive = 'inactive',
  OnLeave = 'on-leave',
  Terminated = 'terminated',
}

export enum DocumentType {
  ID = 'id',
  Passport = 'passport',
  License = 'license',
  Certificate = 'certificate',
  Contract = 'contract',
  Medical = 'medical',
  Other = 'other',
}

export enum LedgerType {
  Material = 'material',
  Labor = 'labor',
  Equipment = 'equipment',
  Subcontractor = 'subcontractor',
  General = 'general',
}

export enum LedgerEntryType {
  Credit = 'credit',
  Debit = 'debit',
}

// Core Interfaces
export interface BOQSection {
  id: string;
  name: string;
  description: string;
  items: BOQItem[];
}

export interface BOQItem {
  id: string;
  sectionId: string;
  type: BOQItemType;
  code: string;
  description: string;
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
  hsnCode?: string;
  specifications?: string;
}

export interface Laborer {
  id: string;
  name: string;
  role: string;
  dailyWage: number;
  overtimeRate?: number;
  phone?: string;
  address?: string;
  emergencyContact?: string;
  bankDetails?: BankDetails;
  isActive: boolean;
  joinedDate: string;
}

export interface BankDetails {
  accountNumber: string;
  bankName: string;
  branch: string;
  ifscCode: string;
  accountHolderName: string;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  date: string;
  supplierId: string;
  supplierName: string;
  items: PurchaseOrderItem[];
  totalAmount: number;
  status: PurchaseOrderStatus;
  deliveryDate?: string;
  notes?: string;
  createdBy: string;
  approvedBy?: string;
  approvedDate?: string;
}

export interface PurchaseOrderItem {
  id: string;
  materialId: string;
  materialName: string;
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
  hsnCode?: string;
}

export interface DSRRecord {
  id: string;
  date: string;
  projectId: string;
  projectName: string;
  preparedBy: string;
  weather: string;
  manpower: DSRManpower[];
  equipment: DSREquipment[];
  materials: DSRMaterial[];
  workDone: DSRWorkDone[];
  remarks: string;
  status: DSRStatus;
  submittedDate?: string;
  approvedBy?: string;
  approvedDate?: string;
}

export interface DSRManpower {
  id: string;
  laborerId: string;
  laborerName: string;
  role: string;
  count: number;
  hours: number;
  overtimeHours: number;
}

export interface DSREquipment {
  id: string;
  equipmentName: string;
  hours: number;
  rate: number;
  amount: number;
}

export interface DSRMaterial {
  id: string;
  materialId: string;
  materialName: string;
  unit: string;
  quantityReceived: number;
  quantityUsed: number;
  quantityBalance: number;
  rate: number;
  amount: number;
}

export interface DSRWorkDone {
  id: string;
  boqItemId: string;
  description: string;
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
}

export interface AttendanceRecord {
  id: string;
  date: string;
  laborerId: string;
  laborerName: string;
  status: AttendanceStatus;
  checkIn?: string;
  checkOut?: string;
  overtimeHours: number;
  remarks?: string;
}

export interface Billing {
  id: string;
  billNumber: string;
  date: string;
  projectId: string;
  projectName: string;
  clientId: string;
  clientName: string;
  items: BillingItem[];
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  status: BillingStatus;
  dueDate?: string;
  paidDate?: string;
  notes?: string;
  retentionPercentage?: number;
  retentionAmount?: number;
}

export interface BillingItem {
  id: string;
  description: string;
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
  boqReference?: string;
}

export interface WorkProgressItem {
  id: string;
  boqItemId: string;
  description: string;
  plannedQuantity: number;
  completedQuantity: number;
  remainingQuantity: number;
  unit: string;
  progressPercentage: number;
  status: WorkProgressStatus;
  startDate?: string;
  endDate?: string;
  actualStartDate?: string;
  actualEndDate?: string;
}

export interface Milestone {
  id: string;
  name: string;
  description: string;
  plannedStartDate: string;
  plannedEndDate: string;
  actualStartDate?: string;
  actualEndDate?: string;
  status: MilestoneStatus;
  progressPercentage: number;
  dependencies: string[];
  responsibleParty: string;
}

export interface StaffMember {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  dateOfBirth: string;
  gender: 'male' | 'female' | 'other';
  bloodGroup?: string;
  emergencyContact: EmergencyContact;
  staffType: StaffType;
  department: string;
  designation: string;
  joiningDate: string;
  status: StaffStatus;
  bankDetails: BankDetails;
  panNumber?: string;
  aadhaarNumber?: string;
  esiNumber?: string;
  pfNumber?: string;
  salary: SalaryDetails;
  documents: StaffDocument[];
  leaveBalance: LeaveBalance;
  skills: string[];
  qualifications: Qualification[];
  experience: Experience[];
}

export interface EmergencyContact {
  name: string;
  relationship: string;
  phone: string;
  address: string;
}

export interface SalaryDetails {
  basic: number;
  hra: number;
  da: number;
  conveyance: number;
  medical: number;
  specialAllowance: number;
  gross: number;
  pf: number;
  esi: number;
  professionalTax: number;
  tds: number;
  net: number;
}

export interface StaffDocument {
  id: string;
  type: DocumentType;
  name: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  uploadDate: string;
  expiryDate?: string;
  isVerified: boolean;
  verifiedBy?: string;
  verifiedDate?: string;
}

export interface LeaveBalance {
  annual: number;
  sick: number;
  casual: number;
  maternity: number;
  paternity: number;
}

export interface Qualification {
  id: string;
  degree: string;
  institution: string;
  year: number;
  percentage?: number;
}

export interface Experience {
  id: string;
  company: string;
  role: string;
  startDate: string;
  endDate?: string;
  description: string;
}

export interface MaterialInvoice {
  id: string;
  invoiceNumber: string;
  date: string;
  supplierId: string;
  supplierName: string;
  poId?: string;
  poNumber?: string;
  items: MaterialInvoiceItem[];
  subtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
  discountAmount: number;
  totalAmount: number;
  status: 'pending' | 'paid' | 'partial' | 'cancelled';
  paymentTerms?: string;
  dueDate?: string;
  paidDate?: string;
  notes?: string;
}

export interface MaterialInvoiceItem {
  id: string;
  materialId: string;
  materialName: string;
  hsnCode?: string;
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
}

export interface LedgerEntry {
  id: string;
  date: string;
  type: LedgerType;
  entryType: LedgerEntryType;
  referenceId: string;
  referenceNumber: string;
  partyName: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  projectId?: string;
  projectName?: string;
}

export interface Project {
  id: string;
  name: string;
  code: string;
  clientId: string;
  clientName: string;
  startDate: string;
  endDate: string;
  status: 'planning' | 'active' | 'on-hold' | 'completed' | 'cancelled';
  budget: number;
  location: string;
  managerId: string;
  managerName: string;
}

export interface Client {
  id: string;
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  gstNumber?: string;
  panNumber?: string;
}

export interface Supplier {
  id: string;
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  gstNumber?: string;
  panNumber?: string;
  paymentTerms?: string;
}

export interface Material {
  id: string;
  code: string;
  name: string;
  unit: string;
  standardRate: number;
  hsnCode?: string;
  category: string;
  specifications?: string;
  minimumStock: number;
  currentStock: number;
}

export interface Equipment {
  id: string;
  name: string;
  type: string;
  hourlyRate: number;
  dailyRate: number;
  monthlyRate: number;
  specifications?: string;
  isActive: boolean;
}

export interface FiscalYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
}

// UI Types
export interface SelectOption {
  value: string;
  label: string;
}

export interface TableColumn<T> {
  key: string;
  header: string;
  width?: string;
  render?: (item: T, index: number) => React.ReactNode;
  sortable?: boolean;
  align?: 'left' | 'center' | 'right';
}

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  showCloseButton?: boolean;
}

export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'primary' | 'warning';
}

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
  duration?: number;
}

export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
}

export interface SortState {
  key: string;
  direction: 'asc' | 'desc';
}

export interface FilterState {
  [key: string]: string | number | boolean | string[] | number[] | undefined;
}

// Hook Return Types
export interface UseLocalStorageReturn<T> {
  value: T;
  setValue: (value: T | ((prev: T) => T)) => void;
  removeValue: () => void;
}

export interface UseDebounceReturn<T> {
  debouncedValue: T;
  isDebouncing: boolean;
}

// Chart Data Types
export interface ChartDataPoint {
  name: string;
  value: number;
  [key: string]: string | number;
}

export interface GanttTask {
  id: string;
  name: string;
  start: Date;
  end: Date;
  progress: number;
  dependencies: string[];
  assignee?: string;
  color?: string;
}

// Settings Types
export interface AppSettings {
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  gstNumber: string;
  panNumber: string;
  defaultCurrency: string;
  timezone: string;
  dateFormat: string;
  fiscalYearStart: number; // month (1-12)
  enableNotifications: boolean;
  autoSaveInterval: number;
  theme: 'light' | 'dark' | 'system';
  language: 'en' | 'ne';
}

export interface User {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'manager' | 'engineer' | 'accountant' | 'viewer';
  permissions: string[];
  lastLogin?: string;
  isActive: boolean;
}

// Report Types
export interface ReportConfig {
  type: 'boq' | 'dsr' | 'attendance' | 'billing' | 'progress' | 'ledger' | 'staff';
  filters: FilterState;
  dateRange?: { start: string; end: string };
  groupBy?: string;
  format: 'pdf' | 'excel' | 'csv';
}

export interface NepaliDate {
  year: number;
  month: number;
  day: number;
  bsString: string;
  adString: string;
}

// Component Props Types
export interface PageProps {
  // Common props passed to page components
}

export interface LayoutProps {
  children: React.ReactNode;
}

export interface SidebarProps {
  currentPage: Page;
  onPageChange: (page: Page) => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export interface HeaderProps {
  currentPage: Page;
  user?: User;
  onLogout?: () => void;
  onSettings?: () => void;
  notifications?: Toast[];
  onDismissNotification?: (id: string) => void;
}