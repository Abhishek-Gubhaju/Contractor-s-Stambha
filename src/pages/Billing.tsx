import React, { useState, useMemo } from 'react';
import { FileUp, FileDown, Plus, X } from 'lucide-react';
import { formatCurrency, getCurrentDateInTimezone } from '../utils';
import { getTodayBS, formatBS } from '../utils/nepaliDate';
import { notify } from '../components/ui/DialogHost';
// S5.2 auto-source: Billing raises Ledger entries (invoice + receipt) —
// the Ledger never re-keys Billing data itself (S0.4).
import { syncBillingInvoice, billingReceiptEntry, billingLinkStatus } from '../services/booksService';

export default function BillingPage(props:any) {
  const { billingEntries, setBillingEntries, yearMonth, timezone } = props;
  const [showBillEntry, setShowBillEntry] = useState(false);
  const [billId, setBillId] = useState("");
  const [billingDocNo, setBillingDocNo] = useState("");
  const [date, setDate] = useState("");
  const [client, setClient] = useState("");
  const [status, setStatus] = useState("Pending");
  const [amount, setAmount] = useState("");
  const [bsRate, setBsRate] = useState("");
  const [discAmount, setDiscAmount] = useState("");
  const [netAmount, setNetAmount] = useState("");
  const [grossTotal, setGrossTotal] = useState("");
  const [panCard, setPanCard] = useState("");
  const [gstNo, setGstNo] = useState("");
  const [tax, setTax] = useState("");
  const [remark, setRemark] = useState("");
  const [docStatus, setDocStatus] = useState("draft");
  const [filterDocStatus, setFilterDocStatus] = useState("all");

  const today = getCurrentDateInTimezone(timezone);

  const filteredRows = useMemo(() => {
    const ym = `${yearMonth.year}/${String(yearMonth.month).padStart(2, "0")}`;
    return billingEntries.filter((e:any) => {
      const rowStatus = e.docStatus ?? e?.data?.docStatus;
      if (filterDocStatus !== "all" && rowStatus !== filterDocStatus) return false;
      const rowYm = e?.data?.monthlyYearMonth || "";
      return rowYm === ym || String(e.billId || e?.data?.BillId || "").startsWith(ym);
    });
  }, [billingEntries, yearMonth, filterDocStatus]);

  const [totalDocs, setTotalDocs] = useState(0);
  const [approvedDocs, setApprovedDocs] = useState(0);
  const [pendingDocs, setPendingDocs] = useState(0);
  const [totalAmt, setTotalAmt] = useState(0);
  const [totalAmtApproved, setTotalAmtApproved] = useState(0);
  const [totalAmtPending, setTotalAmtPending] = useState(0);
  const [openBillEntries, setOpenBillEntries] = useState(0);
  const [openAmt, setOpenAmt] = useState(0);

  const stats = useMemo(() => {
    const docs = filteredRows;
    const ymKey = `${yearMonth.year}/${String(yearMonth.month).padStart(2, "0")}`;
    const docsWithYear = docs.filter((d: any) => (d?.data?.monthlyYearMonth || "") === ymKey || String(d.billId || "").startsWith(ymKey));
    const approved = docsWithYear.filter((d: any) => d.docStatus === "approved");
    const pendingPayment = docsWithYear.filter((d: any) => d.docStatus === "pending");
    const draftDocs = docsWithYear.filter((d: any) => d.docStatus === "draft");
    const total = docsWithYear.reduce((s: number, d: any) => s + (d.netAmount || 0), 0);
    const approvedTotal = approved.reduce((s: number, d: any) => s + (d.netAmount || 0), 0);
    const draftTotal = draftDocs.reduce((s: number, d: any) => s + (d.netAmount || 0), 0);
    return {
      totalDocs: docsWithYear.length,
      approvedDocs: approved.length,
      pendingDocs: pendingPayment.length,
      draftDocs: draftDocs.length,
      draftTotal,
      totalAmt: total,
      totalAmtApproved: approvedTotal,
      totalAmtPending: pendingPayment.reduce((s: number, d: any) => s + (d.netAmount || 0), 0),
      totalAmtDraft: draftTotal,
      openBillEntries: docsWithYear.filter((d: any) => d.netAmount > 0 && d.docStatus === "pending").length,
      openAmt: docsWithYear.filter((d: any) => d.netAmount > 0 && d.docStatus === "pending").reduce((s: number, d: any) => s + (d.netAmount || 0), 0),
    };
  }, [filteredRows, yearMonth]);

  const netAmountTotal = netAmount !== "" ? parseFloat(netAmount) : 0;
  const hasChildFields = Boolean(netAmount) && netAmount !== "";

  const todayVal = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }).replace(/\//g, "-");

  const handleSaveBill = (e:React.MouseEvent) => {
    e.preventDefault();
    if (!billId || !billingDocNo || !client || !date || !amount) {
      notify("Please fill in all required fields.", 'error');
      return;
    }
    const row = {
      billId,
      docStatus,
      netAmount: netAmountTotal,
      data: {
        BillId: billId,
        DocNo: billingDocNo,
        Date: date,
        Client: client,
        Status: status,
        Amount: parseFloat(amount),
        BsRate: bsRate ? parseFloat(bsRate) : 0,
        DiscountAmount: discAmount ? parseFloat(discAmount) : 0,
        NetAmount: netAmountTotal,
        GrossTotal: grossTotal ? parseFloat(grossTotal) : 0,
        PanCard: panCard,
        GstNo: gstNo,
        Tax: tax ? parseFloat(tax) : 0,
        notes: remark,
        docStatus,
        monthlyYearMonth: `${yearMonth.year}/${String(yearMonth.month).padStart(2,"0")}`,
      },
      rowData: {
        date,
        billId,
        billingDocNo,
        client,
        status,
        amount: parseFloat(amount),
        bsRate: bsRate ? parseFloat(bsRate) : null,
        discountAmount: discAmount ? parseFloat(discAmount) : 0,
        netAmount: netAmountTotal,
        grossTotal: grossTotal ? parseFloat(grossTotal) : 0,
        panCard,
        gstNo,
        tax: tax ? parseFloat(tax) : 0,
        remark,
        docStatus,
        monthlyYearMonth: `${yearMonth.year}/${String(yearMonth.month).padStart(2,"0")}`,
      },
    };
    const existing = billingEntries.findIndex((b:any) => b.billId === billId);
    if (existing >= 0) {
      const updated = [...billingEntries];
      updated[existing] = row;
      setBillingEntries(updated);
    } else {
      setBillingEntries([...billingEntries, row]);
    }
    // S5.2: invoice raised → client-invoice auto-entry (idempotent per billId).
    if (docStatus !== 'draft') {
      try {
        const synced = syncBillingInvoice({
          billId,
          client,
          amount: netAmountTotal,
          date: String(date || today).slice(0, 10),
          retention_pct: 0,
        });
        if (synced.action === 'posted') notify(`Ledger invoice ${synced.entry?.id} posted.`);
        if (synced.action === 'corrected') {
          notify(`Ledger invoice corrected — ${synced.reversed.join(', ')} reversed, ${synced.entry?.id} posted.`);
        }
      } catch (e) {
        // Bills still save; the row shows "not posted" and the reason is loud.
        notify(`Billing saved, but the ledger was not updated: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    }
    setShowBillEntry(false);
    resetForm();
  };

  const resetForm = () => {
    setShowBillEntry(false);
    setBillId("");
    setBillingDocNo("");
    setDate("");
    setClient("");
    setStatus("Pending");
    setAmount("");
    setBsRate("");
    setDiscAmount("");
    setNetAmount("");
    setGrossTotal("");
    setPanCard("");
    setGstNo("");
    setTax("");
    setRemark("");
    setDocStatus("draft");
    setFilterDocStatus("all");
  };

  const handleCreateCall = () => {
    const prefix = `AUTH-${yearMonth.year.toLowerCase()}/${String(yearMonth.month).padStart(2,"0")}/`;
    if (billId) return;
    const sameMonth = billingEntries.filter((b: any) => String(b.data?.BillId || b.billId || "").startsWith(prefix));
    const seqs = sameMonth.map((b: any) => parseInt(String(b.data?.BillId || b.billId || "").replace(/.*\/(\d+)$/, "$1"), 10) || 0);
    const nextNo = String((seqs.length ? Math.max(...seqs) : 0) + 1).padStart(2, "0");
    setBillId(prefix + nextNo);
    setBillingDocNo(`DOC-${yearMonth.year.toLowerCase()}${String(yearMonth.month).padStart(2,"0")}-${nextNo}`);
    setDate(today);
  };

  const downloadBillAsCSV = (e:React.MouseEvent) => {
    e.preventDefault();
    const headers = ["BillId", "DocNo", "Date", "Client", "Status", "Amount", "BsRate", "DiscountAmount", "NetAmount", "GrossTotal", "PanCard", "GstNo", "Tax", "Notes", "docStatus", "monthlyYearMonth"];
    const rows = filteredRows.map((row: any) => {
      const d = row.data || row;
      return [
        `"${d.BillId || d.billId || ""}"`,
        `"${d.DocNo || d.billingDocNo || ""}"`,
        `"${d.Date || ""}"`,
        `"${d.Client || d.client || ""}"`,
        `"${d.Status || ""}"`,
        `"${d.Amount || d.amount || 0}"`,
        `"${d.BsRate || ""}"`,
        `"${d.DiscountAmount || 0}"`,
        `"${d.NetAmount || 0}"`,
        `"${d.GrossTotal || 0}"`,
        `"${d.PanCard || ""}"`,
        `"${d.GstNo || ""}"`,
        `"${d.Tax || 0}"`,
        `"${d.notes || d.remark || ""}"`,
        `"${d.docStatus || ""}"`,
        `"${d.monthlyYearMonth || ""}"`,
      ].join(",");
    });
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const fileURL = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = fileURL;
    link.download = `billing_${yearMonth.year}_${String(yearMonth.month).padStart(2,"0")}.csv`;
    link.click();
    window.URL.revokeObjectURL(fileURL);
  };

  const [calling, setCalling] = useState(false);

  const updateDocStatusById = (billId:string, status:string) => {
    const prevRow = billingEntries.find((b:any) => b.billId === billId);
    const prevStatus = prevRow?.docStatus ?? prevRow?.data?.docStatus ?? 'draft';
    setBillingEntries((prev: any) => prev.map((b:any) => {
      if (b.billId === billId) {
        return {
          ...b,
          docStatus: status,
          data: { ...b.data, docStatus: status },
          rowData: { ...b.rowData, docStatus: status },
        };
      }
      return b;
    }));
    // S5.2 auto-sources (idempotent per billId):
    //   draft → pending  : invoice raised → client-invoice entry
    //   → approved       : money received → client-receipt entry
    try {
      const amount = Number(prevRow?.netAmount || prevRow?.data?.NetAmount || 0);
      const clientName = String(prevRow?.data?.Client || prevRow?.rowData?.client || '');
      const adDate = String(prevRow?.rowData?.date || prevRow?.data?.Date || today).slice(0, 10);
      if (status !== 'draft') syncBillingInvoice({ billId, client: clientName, amount, date: adDate, retention_pct: 0 });
      if (status === 'approved' && prevStatus !== 'approved') {
        billingReceiptEntry({ billId, client: clientName, amount, date: adDate, retention_release: 0 });
      }
    } catch (e) {
      notify(`Status changed, but the ledger was not updated: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1>Billing</h1><p>Invoices and billing records</p><p className="text-xs text-indigo-600 font-medium">B.S. Today: {formatBS(getTodayBS())}</p></div>
        <div className="flex gap-2">
          <button
            className="flex items-center gap-2 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium"
            onClick={downloadBillAsCSV}
          >
            <FileDown className="w-4 h-4" /> Export
          </button>
          <button
            className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium"
            onClick={() => setShowBillEntry(true)}
          >
            <Plus className="w-4 h-4" /> Create Bill
          </button>
        </div>
      </div>

      <div className="bg-gray-50 rounded-xl p-6">
        <h3 className="font-semibold mb-4">Billing Summary</h3>
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-white rounded-lg p-4 text-center">
            <p className="text-xs text-gray-500 mb-1">Total Docs</p>
            <p className="text-2xl font-bold text-gray-800">{stats.totalDocs}</p>
          </div>
          <div className="bg-white rounded-lg p-4 text-center">
            <p className="text-xs text-gray-500 mb-1">Approved</p>
            <p className="text-2xl font-bold text-green-600">{stats.approvedDocs}</p>
          </div>
          <div className="bg-white rounded-lg p-4 text-center">
            <p className="text-xs text-gray-500 mb-1">Pending</p>
            <p className="text-2xl font-bold text-amber-600">{stats.pendingDocs}</p>
          </div>
          <div className="bg-white rounded-lg p-4 text-center">
            <p className="text-xs text-gray-500 mb-1">Drafts</p>
            <p className="text-2xl font-bold text-gray-500">{stats.draftDocs}</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 mt-4">
          <div className="bg-white rounded-lg p-4 text-center">
            <p className="text-xs text-gray-500 mb-1">Total Amount</p>
            <p className="text-xl font-bold text-gray-800">{formatCurrency(stats.totalAmt)}</p>
          </div>
          <div className="bg-white rounded-lg p-4 text-center">
            <p className="text-xs text-gray-500 mb-1">Approved Amount</p>
            <p className="text-xl font-bold text-green-600">{formatCurrency(stats.totalAmtApproved)}</p>
          </div>
          <div className="bg-white rounded-lg p-4 text-center">
            <p className="text-xs text-gray-500 mb-1">Pending Amount</p>
            <p className="text-xl font-bold text-amber-600">{formatCurrency(stats.totalAmtPending)}</p>
          </div>
        </div>
      </div>

      {showBillEntry && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setShowBillEntry(false)}>
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b flex items-center justify-between">
              <h3 className="text-lg font-bold">Create / Edit Billing</h3>
              <button onClick={() => setShowBillEntry(false)} className="p-2 hover:bg-gray-100 rounded">
                <X className="w-5 h-5" style={{ transform: "scaleX(-1)" }} />
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Bill ID</label>
                  <input
                    type="text"
                    value={billId}
                    onChange={e => setBillId(e.target.value)}
                    placeholder="AUTH-2082/03/01"
                    className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
                    onFocus={handleCreateCall}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Document No</label>
                  <input
                    type="text"
                    value={billingDocNo}
                    onChange={e => setBillingDocNo(e.target.value)}
                    placeholder="DOC-208203-001"
                    className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Date</label>
                  <input
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Client</label>
                  <input
                    type="text"
                    value={client}
                    onChange={e => setClient(e.target.value)}
                    placeholder="Client name"
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Status</label>
                  <select value={status} onChange={e => setStatus(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm">
                    <option value="Pending">Pending</option>
                    <option value="Completed">Completed</option>
                    <option value="Cancelled">Cancelled</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Bill Amount</label>
                  <input
                    type="number"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    placeholder="0"
                    step="0.01"
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">B.S. Rate</label>
                  <input
                    type="number"
                    value={bsRate}
                    onChange={e => setBsRate(e.target.value)}
                    placeholder="e.g., 3.675"
                    step="0.001"
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Discount Amount</label>
                  <input
                    type="number"
                    value={discAmount}
                    onChange={e => setDiscAmount(e.target.value)}
                    placeholder="0"
                    step="0.01"
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Net Amount</label>
                  <input
                    type="number"
                    value={netAmount}
                    onChange={e => setNetAmount(e.target.value)}
                    placeholder="0"
                    step="0.01"
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                    onFocus={() => { if (amount && amount !== "") setNetAmount((parseFloat(amount) - (parseFloat(discAmount) || 0)).toFixed(2)); }}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Gross Total</label>
                  <input
                    type="number"
                    value={grossTotal}
                    onChange={e => setGrossTotal(e.target.value)}
                    placeholder="0"
                    step="0.01"
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">GST No.</label>
                  <input
                    type="text"
                    value={gstNo}
                    onChange={e => setGstNo(e.target.value)}
                    placeholder="GST number"
                    className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">PAN Card</label>
                  <input
                    type="text"
                    value={panCard}
                    onChange={e => setPanCard(e.target.value)}
                    placeholder="PAN number"
                    className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Tax</label>
                  <input
                    type="number"
                    value={tax}
                    onChange={e => setTax(e.target.value)}
                    placeholder="0"
                    step="0.01"
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium mb-1">Remark</label>
                  <input
                    type="text"
                    value={remark}
                    onChange={e => setRemark(e.target.value)}
                    placeholder="Remarks"
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              </div>
            </div>
            <div className="p-6 border-t flex justify-end gap-2">
              <button onClick={() => setShowBillEntry(false)} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
              <button onClick={handleSaveBill} className="px-6 py-2.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-800 font-semibold">Save Billing</button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border">
        <div className="p-4 border-b flex flex-wrap gap-2">
          <button className={`px-3 py-1.5 text-sm rounded-lg border ${filterDocStatus === "all" ? "bg-amber-50 border-amber-300 text-amber-800" : "hover:bg-gray-50 text-gray-600 border-gray-200"}`} onClick={() => setFilterDocStatus("all")}>All</button>
          <button className={`px-3 py-1.5 text-sm rounded-lg border ${filterDocStatus === "approved" ? "bg-green-50 border-green-300 text-green-700" : "hover:bg-gray-50 text-gray-600 border-gray-200"}`} onClick={() => setFilterDocStatus("approved")}>Approved</button>
          <button className={`px-3 py-1.5 text-sm rounded-lg border ${filterDocStatus === "pending" ? "bg-amber-50 border-amber-300 text-amber-800" : "hover:bg-gray-50 text-gray-600 border-gray-200"}`} onClick={() => setFilterDocStatus("pending")}>Pending</button>
          <button className={`px-3 py-1.5 text-sm rounded-lg border ${filterDocStatus === "draft" ? "bg-gray-50 border-gray-300 text-gray-700" : "hover:bg-gray-50 text-gray-600 border-gray-200"}`} onClick={() => setFilterDocStatus("draft")}>Drafts</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Bill ID</th>
                <th className="px-4 py-3 text-left font-semibold">Document No</th>
                <th className="px-4 py-3 text-left font-semibold">Date</th>
                <th className="px-4 py-3 text-left font-semibold">Client</th>
                <th className="px-4 py-3 text-right font-semibold">Amount</th>
                <th className="px-4 py-3 text-right font-semibold">Bs Rate</th>
                <th className="px-4 py-3 text-right font-semibold">Discount</th>
                <th className="px-4 py-3 text-right font-semibold">Net Amount</th>
                <th className="px-4 py-3 text-right font-semibold">GST No.</th>
                <th className="px-4 py-3 text-center font-semibold">Books</th>
                <th className="px-4 py-3 text-center font-semibold">Status</th>
                <th className="px-4 py-3 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredRows.map((row:any) => {
                const d = row.data || row;
                const amt = d.NetAmount || d.netAmount || 0;
                const bsRateVal = d.BsRate || d.bsRate || 0;
                const discAmt = d.DiscountAmount || 0;
                const statusText = d.Status || "Pending";
                const statusBg = d.docStatus === "approved" ? "bg-green-100 text-green-700" : d.docStatus === "pending" ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-700";
                const isApproved = d.docStatus === "approved";
                const isPending = d.docStatus === "pending";
                return (
                  <tr key={d.BillId || d.billId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{d.BillId || d.billId}</td>
                    <td className="px-4 py-3 text-gray-700">{d.DocNo || d.billingDocNo}</td>
                    <td className="px-4 py-3 text-gray-600">{d.Date}</td>
                    <td className="px-4 py-3 text-gray-700">{d.Client || d.client}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatCurrency(d.Amount || 0)}</td>
                    <td className="px-4 py-3 text-right text-gray-500">{bsRateVal > 0 ? bsRateVal.toFixed(3) : "-"}</td>
                    <td className="px-4 py-3 text-right">{discAmt > 0 ? `-${formatCurrency(discAmt)}` : "-"}</td>
                    <td className="px-4 py-3 text-right font-semibold">{formatCurrency(amt)}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-500">{d.GstNo || d.gstNo || "-"}</td>
                    <td className="px-4 py-3 text-center">
                      {(() => {
                        const link = billingLinkStatus(d.BillId || d.billId || "");
                        if (!link.posted) {
                          return <span className="text-[11px] text-gray-400">{d.docStatus === "draft" ? "draft" : "not posted"}</span>;
                        }
                        return (
                          <span
                            className="text-[11px] bg-blue-50 text-blue-700 border border-blue-100 rounded px-1.5 py-0.5 font-mono"
                            title={`invoiced ${link.invoiced} · received ${link.received}${link.superseded ? ` · ${link.superseded} superseded` : ""}`}
                          >
                            {link.invoice_entry}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusBg}`}>
                        {statusText}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {isApproved && (
                        <button
                          className="text-xs text-gray-500 hover:text-amber-600"
                          onClick={() => updateDocStatusById(d.BillId || d.billId, "pending")}
                        >Pending</button>
                      )}
                      {isPending && (
                        <button
                          className="text-xs text-green-600 hover:text-green-700 font-medium"
                          onClick={() => updateDocStatusById(d.BillId || d.billId, "approved")}
                        >
                          Mark Approved
                        </button>
                      )}
                      {d.docStatus === "draft" && (
                        <button
                          className="text-xs text-green-600 hover:text-green-700"
                          onClick={() => updateDocStatusById(d.BillId || d.billId, "pending")}
                        >
                          Move to Pending
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filteredRows.length === 0 && (
                <tr>
                  <td className="px-4 py-12 text-center text-gray-400" colSpan={12}>No billing records found</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
