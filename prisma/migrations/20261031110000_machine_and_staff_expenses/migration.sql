-- An expense can be linked to the machine it was spent on (repair, spares, service, power) or to the employee it was
-- paid to (daily wage, salary, advance, bonus), so both show on the machine / employee and on Finance.
ALTER TABLE "Expense" ADD COLUMN "machineId" TEXT,
ADD COLUMN "employeeId" TEXT;

CREATE INDEX "Expense_machineId_expenseDate_idx" ON "Expense"("machineId", "expenseDate");
CREATE INDEX "Expense_employeeId_expenseDate_idx" ON "Expense"("employeeId", "expenseDate");

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
