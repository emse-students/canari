# The image the edge pins, so the fixture's frontend is the nginx production runs.
FROM nginx:1.30.6-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5
ARG VERSION
COPY frontend.conf /etc/nginx/conf.d/default.conf
# A layer per version, so two releases are two images, as they are in production.
RUN echo "${VERSION}" > /etc/nginx/fixture-version
