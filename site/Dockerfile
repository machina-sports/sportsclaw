FROM nginx:alpine

# Whole site is the built VitePress output (staged into site/html by CI; see
# build-site.yml). nginx serves it at the root with cleanUrls + /docs redirects.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY html/ /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
