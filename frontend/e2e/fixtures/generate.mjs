import ExcelJS from 'exceljs';

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('s');
ws.addRow(['nome', 'telefone', 'cidade', 'grupo', 'tags']);
ws.addRow(['E2E Alice', '+5592987654321', 'Manaus', 'alunos', 'vip']);
ws.addRow(['E2E Bob', '+5511987654321', 'São Paulo', 'clientes', 'prio']);
await wb.xlsx.writeFile(new URL('./contacts.xlsx', import.meta.url));
console.log('Fixture written.');
