# PostgreSQL 17 with pgvector, plus a WAL archive directory owned by postgres
# so continuous archiving (needed for point-in-time recovery) works with a
# named volume.
FROM pgvector/pgvector:pg17

RUN mkdir -p /wal-archive /backups \
 && chown postgres:postgres /wal-archive /backups \
 && chmod 700 /wal-archive /backups

COPY archive-wal.sh /usr/local/bin/archive-wal.sh
COPY titan-entrypoint.sh /usr/local/bin/titan-entrypoint.sh
RUN chmod 755 /usr/local/bin/archive-wal.sh /usr/local/bin/titan-entrypoint.sh

COPY init/ /docker-entrypoint-initdb.d/
RUN chmod 755 /docker-entrypoint-initdb.d/*.sh

ENTRYPOINT ["/usr/local/bin/titan-entrypoint.sh"]
CMD ["postgres"]
