# The base production's frontend image is built on (infrastructure/local/Dockerfile.frontend, held
# equal by deploy-replace.test.sh), so the fixture's frontend is the nginx production runs.
FROM nginx:stable-alpine
ARG VERSION
# frontend.conf reads the target lists; frontend-upstream-lists.conf is an image of 1.6.2 (its
# `upstream` lists), frontend-pre-rotation.conf one from before any list.
ARG CONF=frontend.conf
COPY ${CONF} /etc/nginx/conf.d/default.conf
# A layer per version, so two releases are two images, as they are in production.
RUN echo "${VERSION}" > /etc/nginx/fixture-version
