import React from 'react';
import { DollarSign, TrendingUp, CheckCircle, AlertTriangle, Info } from 'lucide-react';
import { formatCurrency } from '../utils';
import { projectNameOf } from '../services/masterData';
import { getActiveProject } from '../services/projectScope';
import { cumulativeFor } from '../services/dsrService';

export default function JobCostingPage(props: any) {
  const { boqData, dsrData } = props;

  const calculateJobCosting = () => {
    return boqData.flatMap((section: any) =>
      (section.children || []).map((item: any) => {
        // Σ of every reported line for this BOQ item (multi-item reports included).
        const actualWorkDone = cumulativeFor(dsrData, item.itemCode);
        const estimatedCost = (Number(item.estimatedQuantity) || 0) * (Number(item.rate) || 0);
        const progressPercent = item.estimatedQuantity > 0 ? Math.min((actualWorkDone / item.estimatedQuantity) * 100, 100) : 0;
        // Actual cost is captured material + labour cost. Until cost is captured
        // for an item, accrue the estimated cost in proportion to work done —
        // qty × rate is the value of work done (revenue), never a cost basis.
        const captured = (Number(item.actualMaterialCost) || 0) + (Number(item.actualLaborCost) || 0);
        const actualCost = captured > 0 ? captured : (estimatedCost * progressPercent) / 100;
        const variance = estimatedCost - actualCost;
        const variancePercent = estimatedCost > 0 ? (variance / estimatedCost) * 100 : 0;
        return { ...item, sectionName: section.description, actualWorkDone, estimatedCost, actualCost, variance, variancePercent, progressPercent, status: progressPercent >= 100 ? 'completed' : progressPercent > 0 ? 'in-progress' : 'not-started' };
      })
    );
  };

  const jobCostingData = calculateJobCosting();
  const totalEstimated = jobCostingData.reduce((sum: number, item: any) => sum + item.estimatedCost, 0);
  const totalActual = jobCostingData.reduce((sum: number, item: any) => sum + item.actualCost, 0);
  const totalVariance = totalEstimated - totalActual;
  // Physical progress is value-weighted work done; cost burn is money spent.
  // They are different measures and must not share one number.
  const overallProgress = totalEstimated > 0
    ? (jobCostingData.reduce((sum: number, item: any) => sum + (item.estimatedCost * item.progressPercent) / 100, 0) / totalEstimated) * 100
    : 0;
  const costBurn = totalEstimated > 0 ? (totalActual / totalEstimated) * 100 : 0;

  return (
    <div className="space-y-6">
      <div><h1>Job Costing</h1><p>{getActiveProject()}: {projectNameOf(getActiveProject())} - Actual vs Estimated Cost Analysis</p></div>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border p-4"><div className="flex items-center gap-2 mb-1"><DollarSign className="w-4 h-4 text-blue-500"/><span className="text-xs text-gray-500">Total Estimated</span></div><p className="text-2xl font-bold break-words">{formatCurrency(totalEstimated)}</p><p className="text-xs text-gray-400">Budget allocation</p></div>
        <div className="bg-white rounded-xl border p-4"><div className="flex items-center gap-2 mb-1"><TrendingUp className="w-4 h-4 text-green-500"/><span className="text-xs text-gray-500">Total Actual</span></div><p className="text-2xl font-bold break-words text-green-700">{formatCurrency(totalActual)}</p><p className="text-xs text-gray-400">Cost incurred to date</p></div>
        <div className="bg-white rounded-xl border p-4"><div className="flex items-center gap-2 mb-1">{totalVariance>=0?<CheckCircle className="w-4 h-4 text-green-500"/>:<AlertTriangle className="w-4 h-4 text-red-500"/>}<span className="text-xs text-gray-500">Variance</span></div><p className={`text-2xl font-bold break-words ${totalVariance>=0?'text-green-700':'text-red-700'}`}>{formatCurrency(Math.abs(totalVariance))}</p><p className="text-xs text-gray-400">{totalVariance>=0?'Under budget':'Over budget'}</p></div>
        <div className="bg-white rounded-xl border p-4"><div className="flex items-center gap-2 mb-1"><TrendingUp className="w-4 h-4 text-purple-500"/><span className="text-xs text-gray-500">Overall Progress</span></div><p className="text-2xl font-bold break-words text-purple-700">{overallProgress.toFixed(1)}%</p><p className="text-xs text-gray-400">Cost consumed {costBurn.toFixed(1)}%</p><div className="mt-2 w-full bg-gray-100 rounded-full h-2"><div className="bg-purple-500 h-2 rounded-full" style={{width:`${Math.min(overallProgress, 100)}%`}}/></div></div>
      </div>
      <div className="overflow-x-auto bg-white rounded-xl border">
        <table className="w-full text-sm">
          <thead><tr className="bg-gray-50 border-b"><th className="px-4 py-3 text-left font-semibold">Section</th><th className="px-4 py-3 text-left font-semibold">Code</th><th className="px-4 py-3 text-left font-semibold">Description</th><th className="px-4 py-3 text-right font-semibold">Est. Qty</th><th className="px-4 py-3 text-right font-semibold">Actual Qty</th><th className="px-4 py-3 text-right font-semibold">Est. Cost</th><th className="px-4 py-3 text-right font-semibold">Actual Cost</th><th className="px-4 py-3 text-right font-semibold">Variance</th><th className="px-4 py-3 text-right font-semibold">Progress</th></tr></thead>
          <tbody className="divide-y">{jobCostingData.map((item: any, idx: number) => (
            <tr key={idx} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-gray-600 text-xs">{item.sectionName}</td>
              <td className="px-4 py-3 font-mono text-xs text-gray-600">{item.itemCode}</td>
              <td className="px-4 py-3 text-gray-800">{item.description}</td>
              <td className="px-4 py-3 text-right text-gray-700">{item.estimatedQuantity.toLocaleString()} {item.unit}</td>
              <td className="px-4 py-3 text-right font-medium">{item.actualWorkDone.toLocaleString()} {item.unit}</td>
              <td className="px-4 py-3 text-right text-gray-700">{formatCurrency(item.estimatedCost)}</td>
              <td className="px-4 py-3 text-right font-medium">{formatCurrency(item.actualCost)}</td>
              <td className={`px-4 py-3 text-right font-medium ${item.variancePercent<-20?'text-red-700 bg-red-50':item.variancePercent<-10?'text-red-600':item.variance>=0?'text-green-700':'text-red-700'}`}>{item.variance>=0?'+':''}{formatCurrency(item.variance)}<div className="text-xs text-gray-500">{item.variancePercent.toFixed(1)}%</div></td>
              <td className="px-4 py-3 text-right"><div className="flex items-center justify-end gap-2"><div className="w-16 bg-gray-100 rounded-full h-2"><div className={`h-2 rounded-full ${item.progressPercent<50?'bg-red-600':'bg-gray-900'}`} style={{width:`${item.progressPercent}%`}}/></div><span className="text-xs font-medium w-12 text-right">{item.progressPercent.toFixed(1)}%</span></div></td>
            </tr>
          ))}</tbody>
          <tfoot><tr className="bg-slate-50 border-t-2 border-slate-200 font-semibold"><td colSpan={5} className="px-4 py-3 text-gray-700">Totals</td><td className="px-4 py-3 text-right">{formatCurrency(totalEstimated)}</td><td className="px-4 py-3 text-right">{formatCurrency(totalActual)}</td><td className={`px-4 py-3 text-right ${totalVariance>=0?'text-green-700':'text-red-700'}`}>{formatCurrency(Math.abs(totalVariance))}</td><td className="px-4 py-3 text-right text-purple-700">{overallProgress.toFixed(1)}%</td><td></td></tr></tfoot>
        </table>
      </div>
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4"><div className="flex items-start gap-3"><Info className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0"/><div className="text-sm text-blue-800"><p className="font-semibold mb-1">Job Costing Analysis</p><p className="text-xs text-blue-700">Uncosted items are accrued at the estimated rate from DSR progress, so variance shows the real budget position.</p></div></div></div>
    </div>
  );
}
