-- 手写迁移：把旧的 status 拆进 review_status + data_status，并回填 scope。
-- 只搬数据、不动结构，prisma migrate diff 生成不了这种迁移（它只看得见结构差异）。
-- 改列名分三步：0006 加新列、0007（本文件）搬数据、0008 删旧列。

-- 待审批、驳回、撤销：数据从未写入。
UPDATE base_approvals SET review_status = 'pending', data_status = 'unwritten' WHERE status = 'pending';
UPDATE base_approvals SET review_status = 'rejected', data_status = 'unwritten' WHERE status = 'rejected';
UPDATE base_approvals SET review_status = 'withdrawn', data_status = 'unwritten' WHERE status = 'withdrawn';

-- 「批过的」和「没人批直接过的」当初都记成 applied，只有 reviewed_at 分得开它们。
UPDATE base_approvals SET review_status = 'approved', data_status = 'applied' WHERE status = 'applied' AND reviewed_at IS NOT NULL;
UPDATE base_approvals SET review_status = 'none', data_status = 'applied' WHERE status = 'applied' AND reviewed_at IS NULL;
UPDATE base_approvals SET review_status = 'approved', data_status = 'reverted' WHERE status = 'reverted' AND reviewed_at IS NOT NULL;
UPDATE base_approvals SET review_status = 'none', data_status = 'reverted' WHERE status = 'reverted' AND reviewed_at IS NULL;

-- scope 也是新列，按当时的接口路径回填。request_path 为空的是那一列还不存在时留下的记录，
-- 一律当后台操作——来源记不清时按更严的那一边算。
UPDATE base_approvals SET scope = 'self' WHERE request_path <> '' AND request_path NOT LIKE '/api/panel/admin/%';
