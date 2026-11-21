import React, { useState } from 'react';
import { Plus, Trash2, Info } from 'lucide-react';
import { cumulativeDone } from '../services/dsrSyncService';
import { destroyDialog, notify } from '../components/ui/DialogHost';

export default function WorkProgressPage(props: any) {
  const { boqData, dsrData, milestones, setMilestones, timezone } = props;
  const [showCreateMilestone, setShowCreateMilestone] = useState(false);
  const [newMilestone, setNewMilestone] = useState({ name: '', boqCode: '', startDate: '', endDate: '', targetQuantity: '' });
  const allBOQItems = boqData.flatMap((section: any) => section.children || []);

  const progressData = boqData.flatMap((section: any) => (section.children || []).map((item: any) => {
    const actualWork = cumulativeDone(dsrData, item.itemCode); // E1: single aggregation path shared with Gantt sync
    const progressPercent = item.estimatedQuantity > 0 ? (actualWork / item.estimatedQuantity) * 100 : 0;
    const variance = actualWork - item.estimatedQuantity;
    return { sectionCode: section.sectionCode, itemCode: item.itemCode, description: item.description, unit: item.unit, estimatedQuantity: item.estimatedQuantity, actualWork, progressPercent: Math.min(progressPercent, 100), variance, status: progressPercent >= 100 ? 'completed' : progressPercent >= 75 ? 'on-track' : progressPercent >= 50 ? 'behind' : 'critical' };
  }));

  const handleMilestoneBOQChange = (code: string) => {
    const matchedItem = allBOQItems.find((item: any) => item.itemCode.toLowerCase() === code.toLowerCase());
    setNewMilestone(prev => ({ ...prev, boqCode: code, targetQuantity: matchedItem ? matchedItem.estimatedQuantity.toString() : prev.targetQuantity }));
  };

  const createMilestone = () => {
    const name = newMilestone.name.trim();
    const boqCode = newMilestone.boqCode.trim();
    const startDate = newMilestone.startDate.trim();
    const endDate = newMilestone.endDate.trim();
    const targetQty = parseFloat(newMilestone.targetQuantity);
    if (!name) { notify('Please enter a milestone name', 'error'); return; }
    if (!boqCode) { notify('Please select a BOQ work code', 'error'); return; }
    if (!startDate) { notify('Please select a start date', 'error'); return; }
    if (!endDate) { notify('Please select an end date', 'error'); return; }
    if (isNaN(targetQty) || targetQty <= 0) { notify('Please enter a valid target quantity', 'error'); return; }
    if (new Date(endDate) < new Date(startDate)) { notify('End date must be after start date', 'error'); return; }
    const matchedItem = allBOQItems.find((item: any) => item.itemCode.toLowerCase() === boqCode.toLowerCase());
    const actualQty = cumulativeDone(dsrData, boqCode); // E1: single aggregation path
    const progressPercent = targetQty > 0 ? (actualQty / targetQty) * 100 : 0;
    const today = new Date();
    let status: any = 'planned';
    if (progressPercent >= 100) status = 'completed';
    else if (actualQty > 0) status = 'in-progress';
    else if (today > new Date(endDate)) status = 'delayed';
    const milestone: any = { id: `ms-${Date.now()}`, name, boqCode, boqDescription: matchedItem?.description || '', startDate, endDate, targetQuantity: targetQty, unit: matchedItem?.unit || '', actualQuantity: actualQty, status };
    setMilestones([...milestones, milestone]);
    setShowCreateMilestone(false);
    setNewMilestone({ name: '', boqCode: '', startDate: '', endDate: '', targetQuantity: '' });
  };

  const deleteMilestone = async (id: string) => {
    const ok = await destroyDialog({ title: 'Delete milestone', message: 'Delete this milestone?', confirmLabel: 'Delete milestone' });
    if (ok) setMilestones(milestones.filter((m: any) => m.id !== id));
  };

  const overallProgress = progressData.length > 0 ? progressData.reduce((s: number, p: any) => s + p.progressPercent, 0) / progressData.length : 0;
  const completedCount = progressData.filter((p: any) => p.status === 'completed').length;
  const onTrackCount = progressData.filter((p: any) => p.status === 'on-track').length;
  const needsAttention = progressData.filter((p: any) => p.status === 'behind' || p.status === 'critical').length;

  return (
    <div className="space-y-6">
      <div><h1>Work Progress</h1><p>BOQ vs Actual Work Comparison</p></div>
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border p-4"><p className="text-xs text-gray-500">Overall Progress</p><p className="text-2xl font-bold text-amber-700 mt-1">{overallProgress.toFixed(1)}%</p></div>
        <div className="bg-white rounded-xl border p-4"><p className="text-xs text-gray-500">Completed Items</p><p className="text-2xl font-bold text-green-700 mt-1">{completedCount}</p></div>
        <div className="bg-white rounded-xl border p-4"><p className="text-xs text-gray-500">On Track</p><p className="text-2xl font-bold text-blue-700 mt-1">{onTrackCount}</p></div>
        <div className="bg-white rounded-xl border p-4"><p className="text-xs text-gray-500">Needs Attention</p><p className="text-2xl font-bold text-red-700 mt-1">{needsAttention}</p></div>
      </div>
      <div className="overflow-x-auto bg-white rounded-xl border"><table className="w-full text-sm"><thead><tr className="bg-gray-50 border-b"><th className="px-4 py-3 text-left font-semibold">Code</th><th className="px-4 py-3 text-left font-semibold">Description</th><th className="px-4 py-3 text-left font-semibold">Unit</th><th className="px-4 py-3 text-right font-semibold">BOQ Qty</th><th className="px-4 py-3 text-right font-semibold">Actual Work</th><th className="px-4 py-3 text-right font-semibold">Progress</th><th className="px-4 py-3 text-right font-semibold">Variance</th><th className="px-4 py-3 text-center font-semibold">Status</th></tr></thead><tbody className="divide-y">{progressData.map((item:any,idx:number)=>(<tr key={idx} className="hover:bg-gray-50"><td className="px-4 py-3 font-mono text-xs text-gray-600">{item.itemCode}</td><td className="px-4 py-3 text-gray-800">{item.description}</td><td className="px-4 py-3 text-gray-600">{item.unit}</td><td className="px-4 py-3 text-right text-gray-700">{item.estimatedQuantity.toLocaleString()}</td><td className="px-4 py-3 text-right font-medium">{item.actualWork.toLocaleString()}</td><td className="px-4 py-3 text-right"><div className="flex items-center justify-end gap-2"><div className="w-20 bg-gray-100 rounded-full h-2"><div className={`h-2 rounded-full ${item.progressPercent<50?'bg-red-600':'bg-gray-900'}`} style={{width:`${item.progressPercent}%`}}/></div><span className="text-xs font-medium w-12 text-right">{item.progressPercent.toFixed(1)}%</span></div></td><td className={`px-4 py-3 text-right font-medium ${item.variance>=0?'text-green-600':'text-red-600'}`}>{item.variance>=0?'+':''}{item.variance.toFixed(2)}</td><td className="px-4 py-3 text-center"><span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${item.status==='completed'?'bg-green-50 text-green-700':item.status==='on-track'?'bg-gray-100 text-gray-700':item.status==='behind'?'bg-amber-50 text-amber-700':'bg-red-50 text-red-700'}`}>{item.status==='completed'?'✓ Completed':item.status==='on-track'?'● On Track':item.status==='behind'?'⚠ Behind':'⚠ Critical'}</span></td></tr>))}</tbody></table></div>
      <div><div className="flex items-center justify-between mb-4"><h2 className="text-xl font-bold">Project Milestones</h2><button onClick={()=>setShowCreateMilestone(true)} className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium"><Plus className="w-4 h-4"/> Create Milestone</button></div>
        {milestones.length>0?(<div className="grid grid-cols-2 gap-4">{milestones.map((ms:any)=>{const actualQty=cumulativeDone(dsrData, ms.boqCode); /* E1: single aggregation path */const pp=ms.targetQuantity>0?(actualQty/ms.targetQuantity)*100:0;return <div key={ms.id} className="bg-white rounded-xl border p-5 hover:shadow-md"><div className="flex items-start justify-between mb-3"><div className="flex-1"><h4 className="font-semibold mb-1">{ms.name}</h4><div className="flex items-center gap-2 text-xs"><span className="font-mono bg-blue-50 text-blue-700 px-2 py-0.5 rounded">{ms.boqCode}</span><span className={`px-2 py-0.5 rounded-full font-medium ${ms.status==='completed'?'bg-green-50 text-green-700':ms.status==='in-progress'?'bg-gray-100 text-gray-700':ms.status==='delayed'?'bg-red-50 text-red-700':'bg-gray-100 text-gray-700'}`}>{ms.status==='completed'?'✓ Completed':ms.status==='in-progress'?'● In Progress':ms.status==='delayed'?'⚠ Delayed':'○ Planned'}</span></div></div><button onClick={()=>deleteMilestone(ms.id)} className="ml-2 p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"><Trash2 className="w-4 h-4"/></button></div><p className="text-sm text-gray-600 mb-3">{ms.boqDescription}</p><div className="grid grid-cols-2 gap-3 mb-3 text-xs"><div><p className="text-gray-500">Start Date</p><p className="font-medium">{new Date(ms.startDate).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</p></div><div><p className="text-gray-500">End Date</p><p className="font-medium">{new Date(ms.endDate).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</p></div></div><div className="mb-3"><div className="flex items-center justify-between text-xs mb-1"><span className="text-gray-600">Progress</span><span className="font-semibold">{pp.toFixed(1)}%</span></div><div className="w-full bg-gray-100 rounded-full h-2"><div className={`h-2 rounded-full ${pp<50?'bg-red-600':'bg-gray-900'}`} style={{width:`${Math.min(pp,100)}%`}}/></div></div><div className="flex items-center justify-between text-xs pt-3 border-t"><div><span className="text-gray-500">Actual: </span><span className="font-semibold">{ms.actualQuantity.toLocaleString()} {ms.unit}</span></div><div><span className="text-gray-500">Target: </span><span className="font-semibold">{ms.targetQuantity.toLocaleString()} {ms.unit}</span></div></div></div>;})}</div>):(<div className="bg-gray-50 border rounded-xl p-8 text-center"><p className="text-gray-500 mb-2">No milestones created yet</p><p className="text-xs text-gray-400">Click "Create Milestone" to add your first</p></div>)}
      </div>
      <MilestoneModal isOpen={showCreateMilestone} onClose={()=>setShowCreateMilestone(false)} newMilestone={newMilestone} setNewMilestone={setNewMilestone} allBOQItems={allBOQItems} onSave={createMilestone} handleMilestoneBOQChange={handleMilestoneBOQChange} />
    </div>
  );
}

function MilestoneModal({ isOpen, onClose, newMilestone, setNewMilestone, allBOQItems, onSave, handleMilestoneBOQChange }: any) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-md w-full max-h-[90vh] flex flex-col" onClick={e=>e.stopPropagation()}>
        <div className="p-6 border-b flex items-center justify-between"><h3 className="text-lg font-bold">Create New Milestone</h3><button onClick={onClose} className="p-2 hover:bg-gray-100 rounded"><Trash2 className="w-5 h-5" style={{transform:'scaleX(-1)'}}/></button></div>
        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          <div><label className="block text-sm font-medium mb-1">Milestone Name</label><input type="text" value={newMilestone.name} onChange={e=>setNewMilestone({...newMilestone,name:e.target.value})} placeholder="e.g., Foundation Completion" className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
          <div><label className="block text-sm font-medium mb-1">BOQ Work Code</label><input type="text" list="ms-boq" value={newMilestone.boqCode} onChange={e=>handleMilestoneBOQChange(e.target.value)} placeholder="e.g., A.01..." className="w-full border rounded-lg px-3 py-2 text-sm font-mono" /><datalist id="ms-boq">{allBOQItems.map((item:any)=><option key={item.id} value={item.itemCode}>{item.description}</option>)}</datalist></div>
          <div className="grid grid-cols-2 gap-4"><div><label className="block text-sm font-medium mb-1">Start Date</label><input type="date" value={newMilestone.startDate} onChange={e=>setNewMilestone({...newMilestone,startDate:e.target.value})} className="w-full border rounded-lg px-3 py-2 text-sm" /></div><div><label className="block text-sm font-medium mb-1">End Date</label><input type="date" value={newMilestone.endDate} onChange={e=>setNewMilestone({...newMilestone,endDate:e.target.value})} className="w-full border rounded-lg px-3 py-2 text-sm" /></div></div>
          <div><label className="block text-sm font-medium mb-1">Target Quantity</label><input type="number" value={newMilestone.targetQuantity} onChange={e=>setNewMilestone({...newMilestone,targetQuantity:e.target.value})} placeholder="0" step="0.01" className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
          <div className="flex justify-end gap-2 pt-4 border-t"><button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button><button onClick={onSave} className="px-6 py-2.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-800 font-semibold">Create Milestone</button></div>
        </div>
      </div>
    </div>
  );
}
