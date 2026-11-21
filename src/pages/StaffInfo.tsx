import React, { useState } from 'react';
import { Plus, Edit, Trash2, Eye, User, Building2, Mail, Phone, MapPin, X, Camera, FileText, Download } from 'lucide-react';
import { destroyDialog, notify } from '../components/ui/DialogHost';
import { nextStaffCode, readFileAsDataUrl, formatBytes, MAX_DOC_BYTES, MAX_PHOTO_BYTES, MAX_STAFF_RECORD_BYTES, mimeOfDataUrl } from '../services/staffService';
import type { AppStaffDocument } from '../types';

export default function StaffInfoPage(props:any) {
  const { staffData, setStaffData, deletedStaff = [], setDeletedStaff } = props;
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<string>("list");
  const [showDeleted, setShowDeleted] = useState(false);
  const [viewingStaff, setViewingStaff] = useState<any>(null);
  const [previewDoc, setPreviewDoc] = useState<AppStaffDocument | null>(null);
  const nextCode = nextStaffCode([...staffData, ...(deletedStaff || [])]);

  const [form, setForm] = useState({
    code: "",
    firstName: "",
    middleName: "",
    lastName: "",
    phone: "",
    email: "",
    office: "",
    department: "",
    section: "",
    jobTitle: "",
    super: "",
    hireDate: "",
    salary: "",
    address: "",
    dutyTimings: "",
    noticePeriod: "",
    status: "active",
    emergencyContact: "",
    emergencyPhone: "",
    taxStatus: "",
    panCard: "",
    nationalId: "",
    bankAccount: "",
    ifscCode: "",
    bankName: "",
    notes: "",
    photo: "",
    documents: [] as AppStaffDocument[],
  });

  const filtered = staffData.filter((s:any) => {
    const q = search.toLowerCase();
    return (
      s.code?.toLowerCase().includes(q) ||
      s.firstName?.toLowerCase().includes(q) ||
      s.lastName?.toLowerCase().includes(q) ||
      s.email?.toLowerCase().includes(q) ||
      s.department?.toLowerCase().includes(q) ||
      s.jobTitle?.toLowerCase().includes(q)
    );
  });

  const handleClone = (item:any) => {
    setForm({
      code: item.code,
      firstName: item.firstName || "",
      middleName: item.middleName || "",
      lastName: item.lastName || "",
      phone: item.phone || "",
      email: item.email || "",
      office: item.office || "",
      department: item.department || "",
      section: item.section || "",
      jobTitle: item.jobTitle || "",
      super: item.super || "",
      hireDate: item.hireDate || "",
      salary: item.salary || "",
      address: item.address || "",
      dutyTimings: item.dutyTimings || "",
      noticePeriod: item.noticePeriod || "",
      status: item.status || "active",
      emergencyContact: item.emergencyContact || "",
      emergencyPhone: item.emergencyPhone || "",
      taxStatus: item.taxStatus || "",
      panCard: item.panCard || "",
      nationalId: item.nationalId || "",
      bankAccount: item.bankAccount || "",
      ifscCode: item.ifscCode || "",
      bankName: item.bankName || "",
      notes: item.notes || "",
      photo: item.photo || "",
      documents: Array.isArray(item.documents) ? item.documents : [],
    });
    setEditing(true);
    setEditingId(item.id);
    setShowAdd(true);
  };

  const handleSave = () => {
    // A code left blank is generated from the records on file (live + deleted),
    // so it never collides with a retired number.
    const code = String(form.code || "").trim() || nextStaffCode([...staffData, ...(deletedStaff || [])]);
    if (!form.firstName?.trim() || !form.lastName?.trim()) {
      notify("First Name and Last Name are required.", 'error');
      return;
    }
    const exists = staffData.find((s:any) => s.code === code && (!editingId || s.id !== editingId));
    if (exists) {
      notify(`Staff code "${code}" already exists.`, 'error');
      return;
    }
    const now = new Date().toISOString().replace("Z", "+05:45");
    const payload = {
      ...form,
      code,
      photo: form.photo || "",
      documents: Array.isArray(form.documents) ? form.documents : [],
      id: editingId || `staff-${Date.now()}`,
      createdAt: editingId ? (staffData.find((s:any) => s.id === editingId)?.createdAt || now) : now,
      updatedAt: now,
    };
    // Documents live inside the record; refuse one the local store cannot hold
    // rather than pretending it was saved.
    if (JSON.stringify(payload).length > MAX_STAFF_RECORD_BYTES) {
      notify(`This record is too large (${formatBytes(JSON.stringify(payload).length)}). Attach smaller scans — up to ${formatBytes(MAX_STAFF_RECORD_BYTES)} per staff record.`, 'error');
      return;
    }
    if (editingId) {
      setStaffData(staffData.map((s:any) => (s.id === editingId ? payload : s)));
      setEditing(false);
      setEditingId(null);
    } else {
      setStaffData([...staffData, payload]);
    }
    setShowAdd(false);
    resetForm();
  };

  const resetForm = () => {
    setForm({
      code: "",
      firstName: "",
      middleName: "",
      lastName: "",
      phone: "",
      email: "",
      office: "",
      department: "",
      section: "",
      jobTitle: "",
      super: "",
      hireDate: "",
      salary: "",
      address: "",
      dutyTimings: "",
      noticePeriod: "",
      status: "active",
      emergencyContact: "",
      emergencyPhone: "",
      taxStatus: "",
      panCard: "",
      nationalId: "",
      bankAccount: "",
      ifscCode: "",
      bankName: "",
      notes: "",
      photo: "",
      documents: [],
    });
    setEditing(false);
    setEditingId(null);
  };

  const handleDelete = async (id:string) => {
    const ok = await destroyDialog({ title: 'Delete staff record', message: 'Delete this staff record? You can restore it from Recently deleted.', confirmLabel: 'Delete record' });
    if (ok) {
      const record = staffData.find((s:any) => s.id === id);
      if (record && setDeletedStaff) {
        setDeletedStaff([...deletedStaff, { ...record, removedAt: new Date().toISOString() }]);
      }
      setStaffData(staffData.filter((s:any) => s.id !== id));
    }
  };

  const handleRestore = (id:string) => {
    const record = deletedStaff.find((s:any) => s.id === id);
    if (!record || !setStaffData) return;
    const { removedAt, ...rest } = record;
    setStaffData([...staffData, rest]);
    setDeletedStaff(deletedStaff.filter((s:any) => s.id !== id));
  };

  const handlePermanentDelete = async (id:string) => {
    const ok = await destroyDialog({ title: 'Delete permanently', message: 'Permanently delete this staff record? This cannot be undone.', confirmLabel: 'Delete permanently' });
    if (ok) {
      setDeletedStaff(deletedStaff.filter((s:any) => s.id !== id));
    }
  };

  const handleViewDetails = (item:any) => {
    setViewingStaff(item);
  };

  const total = filtered.length;
  const active = filtered.filter((s:any)=>s.status==="active").length;
  const resigned = filtered.filter((s:any)=>s.status==="resigned").length;
  const terminated = filtered.filter((s:any)=>s.status==="terminated").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div><h1>Staff Information</h1><p>Manage employee records and details</p></div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Search by code, name, email, department..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-[200px] border rounded-lg px-3 py-2 text-sm"
          />
          {deletedStaff.length > 0 && (
            <button onClick={() => setShowDeleted(true)} className="flex items-center gap-1.5 bg-white border hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium">
              <Trash2 className="w-4 h-4" /> Deleted ({deletedStaff.length})
            </button>
          )}
          <button data-testid="add-staff" onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> Add Staff
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Total Staff" value={total} color="text-gray-700" />
        <StatCard label="Active" value={active} color="text-green-700" />
        <StatCard label="Resigned" value={resigned} color="text-blue-700" />
        <StatCard label="Terminated" value={terminated} color="text-red-700" />
      </div>

      {view === "list" ? (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Code</th>
                  <th className="px-4 py-3 text-left font-semibold">Name</th>
                  <th className="px-4 py-3 text-left font-semibold">Department</th>
                  <th className="px-4 py-3 text-left font-semibold">Job Title</th>
                  <th className="px-4 py-3 text-center font-semibold">Status</th>
                  <th className="px-4 py-3 text-center font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((staff:any) => (
                  <tr key={staff.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{staff.code}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Avatar staff={staff} className="w-7 h-7 text-[11px]" />
                        <span>{staff.firstName} {staff.lastName}</span>
                        {documentsOf(staff).length > 0 && (
                          <span className="text-[10px] text-gray-400 flex items-center gap-0.5"><FileText className="w-3 h-3" />{documentsOf(staff).length}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{staff.department}</td>
                    <td className="px-4 py-3 text-gray-600">{staff.jobTitle}</td>
                    <td className="px-4 py-3 text-center">
                      <StatusBadge status={staff.status} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => handleClone(staff)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="Edit"><Edit className="w-4 h-4" /></button>
                        <button onClick={() => handleViewDetails(staff)} className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded" title="View"><Eye className="w-4 h-4" /></button>
                        <button onClick={() => handleDelete(staff.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (
            <div className="p-12 text-center text-gray-400">
              <p className="text-lg font-medium">No staff found</p>
              <p className="text-sm mt-1">Try a different search or add a new staff record.</p>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((staff:any) => (
            <StaffCard key={staff.id} staff={staff} onEdit={() => handleClone(staff)} onView={() => handleViewDetails(staff)} />
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full bg-gray-50 border rounded-xl p-8 text-center text-gray-400">
              <p className="text-lg font-medium">No staff found</p>
              <p className="text-sm mt-1">Add a new staff record to get started.</p>
            </div>
          )}
        </div>
      )}

      {showAdd && (
        <AddStaffModal isOpen={true} onClose={() => { setShowAdd(false); resetForm(); }} form={form} setForm={setForm} onSave={handleSave} editing={editing} editingId={editingId} staffData={staffData} nextCode={nextCode} />
      )}

      {viewingStaff && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setViewingStaff(null)}>
          <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Avatar staff={viewingStaff} className="w-12 h-12 text-base" />
                <div><h3 className="text-lg font-bold">{viewingStaff.firstName} {viewingStaff.lastName}</h3><p className="text-sm text-gray-500 font-mono">{viewingStaff.code}</p></div>
              </div>
              <button onClick={() => setViewingStaff(null)} className="p-2 hover:bg-gray-100 rounded" aria-label="Close details"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 grid grid-cols-2 gap-4 text-sm">
              <Detail label="Department" value={viewingStaff.department} />
              <Detail label="Job Title" value={viewingStaff.jobTitle} />
              <Detail label="Email" value={viewingStaff.email} />
              <Detail label="Phone" value={viewingStaff.phone} />
              <Detail label="Office" value={viewingStaff.office} />
              <Detail label="Status" value={viewingStaff.status} />
              <Detail label="Join Date" value={viewingStaff.hireDate} />
              <Detail label="Salary" value={viewingStaff.salary} />
              <Detail label="PAN" value={viewingStaff.panCard} />
              <Detail label="Bank" value={viewingStaff.bankName} />
              <div className="col-span-2"><Detail label="Address" value={viewingStaff.address} /></div>
              <div className="col-span-2"><Detail label="Notes" value={viewingStaff.notes} /></div>
              <div className="col-span-2 border-t pt-3" data-testid="staff-documents">
                <p className="text-xs text-gray-500 mb-2">Documents ({documentsOf(viewingStaff).length})</p>
                {documentsOf(viewingStaff).length === 0 ? (
                  <p className="text-xs text-gray-400">No documents on file. Edit this staff record to attach a citizenship copy, letter or certificate.</p>
                ) : (
                  <ul className="divide-y border rounded-lg">
                    {documentsOf(viewingStaff).map((doc) => (
                      <li key={doc.id} className="flex items-center justify-between gap-2 px-3 py-2">
                        <span className="flex items-center gap-2 min-w-0">
                          {String(doc.mimeType || '').startsWith('image/') ? (
                            <button type="button" onClick={() => setPreviewDoc(doc)} className="w-10 h-10 rounded border overflow-hidden shrink-0" aria-label={`View ${doc.fileName}`}>
                              <img src={doc.dataUrl} alt={doc.fileName} className="w-full h-full object-cover" />
                            </button>
                          ) : (
                            <FileText className="w-4 h-4 text-gray-400 shrink-0" />
                          )}
                          <span className="min-w-0">
                            <span className="block text-xs font-medium truncate">{doc.fileName}</span>
                            <span className="block text-[11px] text-gray-400">
                              {doc.category || 'Other'} · {formatBytes(doc.sizeBytes)}
                              {doc.uploadedAt ? ` · ${new Date(doc.uploadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
                            </span>
                          </span>
                        </span>
                        <span className="flex items-center gap-1 shrink-0">
                          <button type="button" onClick={() => setPreviewDoc(doc)} className="text-[11px] px-2 py-1 rounded border hover:bg-gray-50">View</button>
                          <a href={doc.dataUrl} download={doc.fileName} className="text-[11px] px-2 py-1 rounded border hover:bg-gray-50">Download</a>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {previewDoc && (
        <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4" onClick={() => setPreviewDoc(null)} data-testid="doc-preview">
          <div className="bg-white rounded-xl max-w-3xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 p-3 border-b">
              <p className="text-sm font-medium truncate">{previewDoc.fileName}</p>
              <div className="flex items-center gap-2 shrink-0">
                <a href={previewDoc.dataUrl} download={previewDoc.fileName} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border hover:bg-gray-50">
                  <Download className="w-3.5 h-3.5" /> Download
                </a>
                <button onClick={() => setPreviewDoc(null)} className="p-1.5 rounded hover:bg-gray-100" aria-label="Close preview"><X className="w-4 h-4" /></button>
              </div>
            </div>
            {(String(previewDoc.mimeType || '').startsWith('image/') || mimeOfDataUrl(previewDoc.dataUrl).startsWith('image/')) ? (
              <img src={previewDoc.dataUrl} alt={previewDoc.fileName} className="max-h-[75vh] mx-auto object-contain p-3" />
            ) : (
              <p className="p-6 text-sm text-gray-500">This file can't be shown in the app. Use Download to open it.</p>
            )}
          </div>
        </div>
      )}

      {showDeleted && deletedStaff.length > 0 && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowDeleted(false)}>
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b flex items-center justify-between">
              <div><h3 className="text-lg font-bold">Recently Deleted Staff</h3><p className="text-sm text-gray-500 mt-1">Restore or permanently delete staff records</p></div>
              <button onClick={() => setShowDeleted(false)} className="p-2 hover:bg-gray-100 rounded" aria-label="Close deleted panel"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 overflow-y-auto flex-1">
              <div className="space-y-3">
                {deletedStaff.map((st:any) => (
                  <div key={st.id} className="p-4 rounded-lg border bg-gray-50">
                    <div className="flex items-center justify-between">
                      <div><p className="text-sm font-medium">{st.firstName} {st.lastName}</p><p className="text-xs text-gray-500 font-mono">{st.code} · {st.department || "-"} · {st.jobTitle || "-"}</p></div>
                      <div className="flex gap-2">
                        <button onClick={() => handleRestore(st.id)} className="px-3 py-1.5 text-xs bg-green-50 text-green-700 rounded-lg hover:bg-green-100 font-medium">Restore</button>
                        <button onClick={() => handlePermanentDelete(st.id)} className="px-3 py-1.5 text-xs bg-red-50 text-red-700 rounded-lg hover:bg-red-100 font-medium">Permanent Delete</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function documentsOf(staff: any): AppStaffDocument[] {
  return Array.isArray(staff?.documents) ? staff.documents : [];
}

function Avatar({ staff, className = '' }: { staff: any; className?: string }) {
  const name = `${staff?.firstName || ''} ${staff?.lastName || ''}`.trim() || 'Staff photo';
  if (staff?.photo) {
    return <img src={staff.photo} alt={name} className={`rounded-full object-cover border bg-gray-50 shrink-0 ${className}`} />;
  }
  const initials = `${staff?.firstName?.[0] || '?'}${staff?.lastName?.[0] || ''}`.toUpperCase();
  return (
    <div className={`rounded-full bg-amber-100 text-amber-700 flex items-center justify-center font-bold shrink-0 ${className}`}>
      {initials}
    </div>
  );
}

function Detail({ label, value }: any) {
  return (
    <div><p className="text-xs text-gray-500">{label}</p><p className="font-medium text-gray-800">{value || "—"}</p></div>
  );
}

function StatCard({ label, value, color }:any) {
  return (
    <div className="bg-white rounded-xl border p-4">
      <p className={`text-xs text-gray-500 ${color}`}>{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function StaffCard({ staff, onEdit, onView }:{staff:any, onEdit:()=>void, onView:()=>void}) {
  const { code, firstName, lastName, department, jobTitle, status, phone, email, hireDate } = staff;
  return (
    <div className="bg-white rounded-xl border p-4 cursor-pointer hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <Avatar staff={staff} className="w-10 h-10 text-sm" />
          <div>
            <h4 className="font-semibold">{firstName} {lastName}</h4>
            <p className="text-xs text-gray-500 font-mono">{code}</p>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <div><p className="text-gray-500">Department</p><p className="font-medium">{department}</p></div>
        <div><p className="text-gray-500">Job Title</p><p className="font-medium">{jobTitle}</p></div>
        <div><p className="text-gray-500">Phone</p><p className="font-medium">{phone || "—"}</p></div>
        <div><p className="text-gray-500">Email</p><p className="font-medium">{email || "—"}</p></div>
        <div><p className="text-gray-500">Hire Date</p><p className="font-medium">{hireDate ? new Date(hireDate).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : "—"}</p></div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <button onClick={onEdit} className="flex items-center gap-1 px-3 py-1 text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded"><Edit className="w-3.5 h-3.5" /> Edit</button>
        <button onClick={onView} className="flex items-center gap-1 px-3 py-1 text-xs text-gray-600 hover:text-amber-600 hover:bg-amber-50 rounded"><Eye className="w-3.5 h-3.5" /> View</button>
      </div>
    </div>
  );
}

function StatusBadge({ status }:{status:string}) {
  const styles = {
    active: "bg-green-100 text-green-700",
    resigned: "bg-blue-100 text-blue-700",
    terminated: "bg-red-100 text-red-700",
  }[status] || "bg-gray-100 text-gray-700";
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${styles}`}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

function AddStaffModal({ isOpen, onClose, form, setForm, onSave, editing, editingId, staffData, nextCode = 'STF-001' }:any) {
  const [docCategory, setDocCategory] = useState<'Photo' | 'Citizenship Copy' | 'Other'>('Citizenship Copy');
  if (!isOpen) return null;

  const docs: AppStaffDocument[] = Array.isArray(form.documents) ? form.documents : [];

  const pickPhoto = async (file?: File | null) => {
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) {
      notify(`Photo must be under ${formatBytes(MAX_PHOTO_BYTES)}.`, 'error');
      return;
    }
    try {
      const read = await readFileAsDataUrl(file);
      // Functional update: a document picked at the same time must not be lost.
      setForm((f: any) => ({ ...f, photo: read.dataUrl }));
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const addDocuments = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added: AppStaffDocument[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_DOC_BYTES) {
        notify(`${file.name} is over ${formatBytes(MAX_DOC_BYTES)} — attach a smaller scan.`, 'error');
        continue;
      }
      try {
        const read = await readFileAsDataUrl(file);
        added.push({
          id: `doc-${Date.now()}-${added.length}`,
          category: docCategory,
          fileName: read.fileName,
          mimeType: read.mimeType,
          sizeBytes: read.sizeBytes,
          uploadedAt: new Date().toISOString(),
          dataUrl: read.dataUrl,
        });
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'error');
      }
    }
    if (added.length === 0) return;
    setForm((f: any) => ({ ...f, documents: [...(Array.isArray(f.documents) ? f.documents : []), ...added] }));
  };

  const removeDoc = (id: string) =>
    setForm((f: any) => ({ ...f, documents: (Array.isArray(f.documents) ? f.documents : []).filter((d: AppStaffDocument) => d.id !== id) }));

  const save = () => onSave();

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-6 border-b flex items-center justify-between">
          <h3 className="text-lg font-bold">{editing ? "Edit Staff" : "Add New Staff"}</h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded">
            <Trash2 className="w-5 h-5" style={{ transform: "scaleX(-1)" }} />
          </button>
        </div>
        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Staff Code</label>
              <input
                type="text"
                data-testid="staff-code"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder={nextCode}
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
              />
              <p className="text-[11px] text-gray-400 mt-1">Leave blank to use {nextCode}.</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">First Name *</label>
              <input
                type="text"
                value={form.firstName}
                onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                placeholder="First name"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Middle Name</label>
              <input
                type="text"
                value={form.middleName}
                onChange={(e) => setForm({ ...form, middleName: e.target.value })}
                placeholder="Middle name"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Last Name *</label>
              <input
                type="text"
                value={form.lastName}
                onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                placeholder="Last name"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="flex items-center gap-4" data-testid="staff-photo-block">
            <Avatar staff={{ firstName: form.firstName, lastName: form.lastName, photo: form.photo }} className="w-16 h-16 text-lg" />
            <div className="space-y-1">
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border rounded-lg cursor-pointer hover:bg-gray-50">
                <Camera className="w-3.5 h-3.5" /> {form.photo ? 'Change photo' : 'Add profile picture'}
                <input type="file" accept="image/*" className="hidden" data-testid="staff-photo-input" onChange={(e) => pickPhoto(e.target.files?.[0])} />
              </label>
              {form.photo && (
                <button type="button" onClick={() => setForm({ ...form, photo: '' })} className="block text-xs text-red-600 hover:underline">Remove photo</button>
              )}
              <p className="text-[11px] text-gray-400">Shown in the list and on the profile. Up to {formatBytes(MAX_PHOTO_BYTES)}.</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Phone</label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="Phone number"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="email@example.com"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Department</label>
              <input
                type="text"
                value={form.department}
                onChange={(e) => setForm({ ...form, department: e.target.value })}
                placeholder="e.g., Engineering"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Section</label>
              <input
                type="text"
                value={form.section}
                onChange={(e) => setForm({ ...form, section: e.target.value })}
                placeholder="Section"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Job Title</label>
              <input
                type="text"
                value={form.jobTitle}
                onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
                placeholder="Job title"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Supervisor</label>
              <input
                type="text"
                value={form.super}
                onChange={(e) => setForm({ ...form, super: e.target.value })}
                placeholder="Supervisor name"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Office</label>
              <input
                type="text"
                value={form.office}
                onChange={(e) => setForm({ ...form, office: e.target.value })}
                placeholder="Office location"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Hire Date</label>
              <input
                type="date"
                value={form.hireDate}
                onChange={(e) => setForm({ ...form, hireDate: e.target.value })}
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Salary (NPR)</label>
              <input
                type="number"
                value={form.salary}
                onChange={(e) => setForm({ ...form, salary: e.target.value })}
                placeholder="0"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Duty Timings</label>
              <input
                type="text"
                value={form.dutyTimings}
                onChange={(e) => setForm({ ...form, dutyTimings: e.target.value })}
                placeholder="e.g., 10AM - 6PM"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Notice Period</label>
              <input
                type="text"
                value={form.noticePeriod}
                onChange={(e) => setForm({ ...form, noticePeriod: e.target.value })}
                placeholder="e.g., 1 month"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Address</label>
              <textarea
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="Full address"
                className="w-full border rounded-lg px-3 py-2 text-sm h-24 resize-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Status</label>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                className="w-full border rounded-lg px-3 py-2 text-sm"
              >
                <option value="active">Active</option>
                <option value="resigned">Resigned</option>
                <option value="terminated">Terminated</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Emergency Contact</label>
              <input
                type="text"
                value={form.emergencyContact}
                onChange={(e) => setForm({ ...form, emergencyContact: e.target.value })}
                placeholder="Contact name"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Emergency Phone</label>
              <input
                type="tel"
                value={form.emergencyPhone}
                onChange={(e) => setForm({ ...form, emergencyPhone: e.target.value })}
                placeholder="Phone number"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Tax Status</label>
              <input
                type="text"
                value={form.taxStatus}
                onChange={(e) => setForm({ ...form, taxStatus: e.target.value })}
                placeholder="Tax status"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">PAN Card</label>
              <input
                type="text"
                value={form.panCard}
                onChange={(e) => setForm({ ...form, panCard: e.target.value })}
                placeholder="PAN number"
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">National ID</label>
              <input
                type="text"
                value={form.nationalId}
                onChange={(e) => setForm({ ...form, nationalId: e.target.value })}
                placeholder="National ID"
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Bank Account</label>
              <input
                type="text"
                value={form.bankAccount}
                onChange={(e) => setForm({ ...form, bankAccount: e.target.value })}
                placeholder="Account number"
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">IFSC Code</label>
              <input
                type="text"
                value={form.ifscCode}
                onChange={(e) => setForm({ ...form, ifscCode: e.target.value })}
                placeholder="IFSC code"
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Bank Name</label>
              <input
                type="text"
                value={form.bankName}
                onChange={(e) => setForm({ ...form, bankName: e.target.value })}
                placeholder="Bank name"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Additional notes"
              className="w-full border rounded-lg px-3 py-2 text-sm h-20 resize-none"
            />
          </div>

          <div className="border-t pt-4 space-y-2" data-testid="staff-doc-block">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Documents <span className="text-gray-400 font-normal">({docs.length})</span></p>
              <div className="flex items-center gap-2">
                <select
                  value={docCategory}
                  onChange={(e) => setDocCategory(e.target.value as 'Photo' | 'Citizenship Copy' | 'Other')}
                  className="border rounded-lg px-2 py-1.5 text-xs"
                  aria-label="Document category"
                >
                  <option value="Citizenship Copy">Citizenship Copy</option>
                  <option value="Photo">Photo</option>
                  <option value="Other">Other</option>
                </select>
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border rounded-lg cursor-pointer hover:bg-gray-50">
                  <Plus className="w-3.5 h-3.5" /> Attach file
                  <input type="file" multiple className="hidden" data-testid="staff-doc-input" onChange={(e) => { addDocuments(e.target.files); e.target.value = ''; }} />
                </label>
              </div>
            </div>
            <p className="text-[11px] text-gray-400">Citizenship copies, appointment letters, certificates — kept with the staff record and included in backups. Up to {formatBytes(MAX_DOC_BYTES)} each.</p>
            {docs.length === 0 ? (
              <p className="text-xs text-gray-400" data-testid="staff-doc-empty">No documents attached yet.</p>
            ) : (
              <ul className="divide-y border rounded-lg">
                {docs.map((doc) => (
                  <li key={doc.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                    <span className="flex items-center gap-2 min-w-0">
                      <FileText className="w-4 h-4 text-gray-400 shrink-0" />
                      <span className="truncate">{doc.fileName}</span>
                      <span className="text-gray-400 shrink-0">{doc.category} · {formatBytes(doc.sizeBytes)}</span>
                    </span>
                    <button type="button" onClick={() => removeDoc(doc.id)} className="text-red-600 shrink-0">Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="p-6 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
          <button data-testid="staff-save" onClick={save} className="px-6 py-2.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-800 font-semibold">
            {editing ? "Update Staff" : "Add Staff"}
          </button>
        </div>
      </div>
    </div>
  );
}
