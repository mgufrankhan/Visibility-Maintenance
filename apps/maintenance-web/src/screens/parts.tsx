import { useState, type FormEvent } from 'react';
import { M, api } from '../api.ts';
import { ErrorBox, PageHeader, Table, emptyRow, useList } from '../ui.tsx';

export function Parts({ siteId }: { siteId: string }) {
  const stores = useList<any>(`${M}/stores?site_id=${siteId}`);
  const parts = useList<any>(`${M}/parts`);
  const [storeId, setStoreId] = useState('');
  const balances = useList<any>(storeId ? `${M}/stores/${storeId}/balances` : null);
  const [err, setErr] = useState<unknown>(null);
  const [sku, setSku] = useState('');
  const [partName, setPartName] = useState('');
  const [unit, setUnit] = useState('ea');
  const [storeCode, setStoreCode] = useState('MAIN');
  const [storeName, setStoreName] = useState('Main stores');
  const [partId, setPartId] = useState('');
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState('Stock receipt');

  const createStore = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api(`${M}/stores`, { method: 'POST', body: JSON.stringify({ site_id: siteId, code: storeCode, name: storeName }) });
      stores.reload();
    } catch (error) {
      setErr(error);
    }
  };

  const createPart = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api(`${M}/parts`, { method: 'POST', body: JSON.stringify({ sku, name: partName, unit }) });
      parts.reload();
      setSku('');
      setPartName('');
    } catch (error) {
      setErr(error);
    }
  };

  const receive = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api(`${M}/stock/receive`, {
        method: 'POST',
        body: JSON.stringify({
          store_id: storeId,
          part_id: partId,
          quantity: Number(qty),
          reason,
          unit_cost: null,
          currency: null,
        }),
      });
      balances.reload();
    } catch (error) {
      setErr(error);
    }
  };

  return (
    <>
      <PageHeader
        title="Parts"
        lede="Stores ledger: receive, reserve, issue and return. Negative stock is blocked; adjustments need a reason."
      />
      <ErrorBox err={stores.err ?? parts.err ?? balances.err ?? err} />

      <div className="split-2">
        <form className="card" onSubmit={(e) => void createStore(e)}>
          <h3 style={{ marginTop: 0 }}>New store</h3>
          <label>Code<input value={storeCode} onChange={(e) => setStoreCode(e.target.value)} required /></label>
          <label>Name<input value={storeName} onChange={(e) => setStoreName(e.target.value)} required /></label>
          <button type="submit">Create store</button>
        </form>
        <form className="card" onSubmit={(e) => void createPart(e)}>
          <h3 style={{ marginTop: 0 }}>New part</h3>
          <label>SKU<input value={sku} onChange={(e) => setSku(e.target.value)} required /></label>
          <label>Name<input value={partName} onChange={(e) => setPartName(e.target.value)} required /></label>
          <label>Unit<input value={unit} onChange={(e) => setUnit(e.target.value)} required /></label>
          <button type="submit">Create part</button>
        </form>
      </div>

      <div className="card">
        <label>Store
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">—</option>
            {stores.items.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
          </select>
        </label>
      </div>

      {storeId && (
        <form className="card" onSubmit={(e) => void receive(e)}>
          <h3>Receive stock</h3>
          <label>Part
            <select value={partId} onChange={(e) => setPartId(e.target.value)} required>
              <option value="">—</option>
              {parts.items.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
            </select>
          </label>
          <label>Quantity<input type="number" min="0.0001" step="any" value={qty} onChange={(e) => setQty(e.target.value)} required /></label>
          <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} required /></label>
          <button type="submit">Receive</button>
        </form>
      )}

      <Table>
        <thead><tr><th>SKU</th><th>Name</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Unit</th></tr></thead>
        <tbody>
          {balances.items.map((b) => (
            <tr key={`${b.store_id}-${b.part_id}`}>
              <td>{b.sku}</td>
              <td>{b.part_name}</td>
              <td>{b.on_hand}</td>
              <td>{b.reserved}</td>
              <td>{b.available}</td>
              <td>{b.unit}</td>
            </tr>
          ))}
          {!balances.items.length && emptyRow(6, balances.loading, storeId ? 'No stock in this store.' : 'Select a store.')}
        </tbody>
      </Table>
    </>
  );
}
