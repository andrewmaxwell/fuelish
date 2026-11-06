-- What the trip list shows for a recording (distance, route outline, stops, fuel profile), worked out
-- from its chunks' tracks once and kept here, instead of reading every chunk's track on every list
-- request. list_key names what it was worked out from (chunk count, drive end, code version); when
-- that changes (a new chunk, a later stop) the list works it out again.
ALTER TABLE recordings ADD COLUMN list_json TEXT;
ALTER TABLE recordings ADD COLUMN list_key TEXT;
